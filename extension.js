const vscode = require('vscode');
const path = require('path');
const fs = require('fs').promises;
const Cerebras = require('@cerebras/cerebras_cloud_sdk');
const { marked } = require('marked');
const hnswlib = require('hnswlib-node');

let cerebrasInferenceWebview;
let selectedModel = 'llama-3.3-70b';

const workspaceIndexKey = 'wscode-workspace-index';
const workspaceEmbeddingsKey = 'wscode-workspace-embeddings';
const workspaceFileContentsKey = 'wscode-workspace-file-contents';

// Global variables for workspace indexing
let isIndexing = false;
let workspaceIndex = null;
let workspaceEmbeddings = null;
let workspaceFileContents = null;

function activate(context) {
    // Load workspace index if it exists
    loadWorkspaceIndex(context);

    const askCommandProvider = vscode.commands.registerCommand('wscode.ask', async function () {
        var apiKey = vscode.workspace.getConfiguration('wscode').get('apiKey');
        if (!apiKey) {
            apiKey = await setupApiKey();
            if (!apiKey) {
                return;
            }
        }

        const userInput = await vscode.window.showInputBox({ prompt: "Ask anything..." }) || "";

        await vscode.commands.executeCommand('workbench.view.extension.wscodeView');

        postQuestion(userInput, context);
    });
    context.subscriptions.push(askCommandProvider);

    const apiKeyCommandProvider = vscode.commands.registerCommand('wscode.setupApiKey', setupApiKey);
    context.subscriptions.push(apiKeyCommandProvider);

    // Register workspace indexing command
    const indexWorkspaceCommandProvider = vscode.commands.registerCommand('wscode.indexWorkspace', async function () {
        await indexWorkspace(context);
    });
    context.subscriptions.push(indexWorkspaceCommandProvider);

    // Register clear workspace index command
    const clearWorkspaceIndexCommandProvider = vscode.commands.registerCommand('wscode.clearWorkspaceIndex', async function () {
        await clearWorkspaceIndex(context);
    });
    context.subscriptions.push(clearWorkspaceIndexCommandProvider);

    const cerebrasInferenceViewProvider = {
        resolveWebviewView: async function (webviewView) {
            cerebrasInferenceWebview = webviewView.webview;

            webviewView.webview.options = {
                enableScripts: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(context.extensionUri, 'media'),
                    vscode.Uri.joinPath(context.extensionUri, 'resources'),
                ]
            };
            webviewView.webview.html = await getWebviewContent(context, webviewView.webview);

            webviewView.webview.onDidReceiveMessage(
                async message => {
                    switch (message.command) {
                        case 'wscode-ask':
                            postQuestion(message.text, context);
                            break;
                        case 'wscode-model-selection':
                            selectedModel = message.value;
                            break;
                        case 'wscode-save-history':
                            storeChatToFile(context, message.html);
                            break;
                    }
                },
                undefined,
                context.subscriptions
            );

            webviewView.onDidChangeVisibility(async () => {
                if (webviewView.visible) {
                    webviewView.webview.html = await getWebviewContent(context, webviewView.webview);
                }
            });
        }
    };
    const cerebrasInferenceWebviewProvider =
        vscode.window.registerWebviewViewProvider('cerebrasInferenceView', cerebrasInferenceViewProvider);
    context.subscriptions.push(cerebrasInferenceWebviewProvider);
}

// Tool definitions for Cerebras API
function getToolDefinitions() {
    return [
        {
            type: "function",
            function: {
                name: "getActiveEditorContext",
                description: "Gets the content of the currently active file editor or the user's text selection within the editor. Call this if the user's question seems to refer implicitly or explicitly to the code they are currently looking at.",
                parameters: {
                    type: "object",
                    properties: {},
                    required: []
                }
            }
        },
        {
            type: "function",
            function: {
                name: "findRelevantContext",
                description: "Searches the indexed codebase for files or snippets relevant to a specific query string. Use this for almost all user questions to find relevant code context. This tool should be your first choice when answering questions about code.",
                parameters: {
                    type: "object",
                    properties: {
                        query: {
                            type: "string",
                            description: "The specific keywords or question to search for in the codebase."
                        }
                    },
                    required: ["query"]
                }
            }
        }
    ];
}

// Function to handle tool calls from Cerebras API
async function executeToolCall(toolCall, context) {
    const functionName = toolCall.function.name;
    let functionArgs = {};
    
    try {
        functionArgs = JSON.parse(toolCall.function.arguments);
    } catch (error) {
        console.error(`[WSCode] Error parsing tool arguments: ${error.message}`);
        return `Error parsing tool arguments: ${error.message}`;
    }

    try {
        if (functionName === 'getActiveEditorContext') {
            return await getActiveEditorContent();
        } else if (functionName === 'findRelevantContext') {
            if (!functionArgs.query) {
                return "Error: Search query parameter is missing.";
            }
            
            if (!workspaceIndex || !workspaceEmbeddings || !workspaceFileContents) {
                const isIndexed = await loadWorkspaceIndex(context);
                if (!isIndexed) {
                    return "Workspace has not been indexed yet. Please run the 'WSCode: Index Workspace for Context' command first.";
                }
            }
            
            const result = findRelevantContext(functionArgs.query);
            console.log(`[WSCode] findRelevantContext result length: ${result.length}`);
            return result;
        } else {
            console.warn(`[WSCode] Unknown tool called: ${functionName}`);
            return `Error: Tool '${functionName}' not found.`;
        }
    } catch (error) {
        console.error(`[WSCode] Error executing tool ${functionName}:`, error);
        return `Error executing tool ${functionName}: ${error.message}`;
    }
}

// Function to get active editor content
async function getActiveEditorContent() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        return "No active text editor found.";
    }
    
    const document = editor.document;
    const selection = editor.selection;
    const fileName = document.fileName;
    const relativePath = vscode.workspace.asRelativePath(fileName);
    
    let text;
    if (!selection.isEmpty) {
        text = document.getText(selection);
        return `Selected text from ${relativePath}:\n\`\`\`\n${text}\n\`\`\``;
    } else {
        text = document.getText();
        const MAX_EDITOR_CONTEXT = 4000;
        if (text.length > MAX_EDITOR_CONTEXT) {
            text = text.substring(0, MAX_EDITOR_CONTEXT) + "\n... (truncated)";
        }
        return `Content of ${relativePath}:\n\`\`\`\n${text}\n\`\`\``;
    }
}

// Function to find relevant context using vector search
function findRelevantContext(query) {
    if (!workspaceIndex || !workspaceEmbeddings || !workspaceFileContents) {
        return "Workspace has not been indexed yet.";
    }
    
    try {
        // Create a simple embedding for the query
        const queryEmbeddingFloat32 = createSimpleEmbedding(query);
        
        // Convert to regular array for compatibility with hnswlib-node
        const queryEmbedding = Array.from(queryEmbeddingFloat32);
        
        // Search for similar content
        const k = 3; // Number of results to return
        const result = workspaceIndex.searchKnn(queryEmbedding, k);
        
        if (!result || !result.neighbors || result.neighbors.length === 0) {
            return "No relevant files found for the query.";
        }
        
        let relevantContext = "Relevant files found:\n\n";
        
        for (let i = 0; i < result.neighbors.length; i++) {
            const fileIndex = result.neighbors[i];
            if (fileIndex >= 0 && fileIndex < workspaceEmbeddings.length) {
                const filePaths = Object.keys(workspaceFileContents);
                if (fileIndex < filePaths.length) {
                    const filePath = filePaths[fileIndex];
                    const fileContent = workspaceFileContents[filePath];
                    
                    // Get a more substantial preview of the file content (first 1500 chars)
                    const previewLength = Math.min(1500, fileContent.length);
                    const preview = fileContent.substring(0, previewLength) + 
                                   (fileContent.length > previewLength ? "\n...(content truncated)..." : "");
                    
                    // Calculate similarity score (distance is inverse of similarity)
                    const similarityScore = Math.round((1 - result.distances[i]) * 100);
                    
                    relevantContext += `File: ${filePath} (Relevance: ${similarityScore}%)\n\`\`\`\n${preview}\n\`\`\`\n\n`;
                }
            }
        }
        
        return relevantContext;
    } catch (error) {
        console.error("[WSCode] Error searching workspace index:", error);
        return `Error searching workspace: ${error.message}`;
    }
}

// Function to create a simple embedding for text (placeholder)
// In a real implementation, this would use a proper embedding model
function createSimpleEmbedding(text) {
    // This is a very simple embedding function for demonstration
    // It creates a vector of 128 dimensions based on character frequencies
    const embedding = new Float32Array(128).fill(0);
    
    // Normalize the text
    const normalizedText = text.toLowerCase().replace(/[^\w\s]/g, '');
    
    // Count character frequencies
    for (let i = 0; i < normalizedText.length; i++) {
        const char = normalizedText.charCodeAt(i);
        if (char >= 97 && char <= 122) { // a-z
            embedding[char - 97] += 1;
        } else if (char >= 48 && char <= 57) { // 0-9
            embedding[char - 48 + 26] += 1;
        }
    }
    
    // Add some word-level features
    const words = normalizedText.split(/\s+/);
    embedding[36] = words.length; // Number of words
    
    // Average word length
    let totalLength = 0;
    for (const word of words) {
        totalLength += word.length;
    }
    embedding[37] = words.length > 0 ? totalLength / words.length : 0;
    
    // Normalize the embedding
    let sum = 0;
    for (let i = 0; i < embedding.length; i++) {
        sum += embedding[i] * embedding[i];
    }
    const norm = Math.sqrt(sum);
    
    if (norm > 0) {
        for (let i = 0; i < embedding.length; i++) {
            embedding[i] /= norm;
        }
    }
    
    return embedding;
}

// Function to index the workspace
async function indexWorkspace(context) {
    if (isIndexing) {
        vscode.window.showInformationMessage('Workspace indexing is already in progress.');
        return;
    }
    
    isIndexing = true;
    vscode.window.showInformationMessage('Indexing workspace...');
    
    try {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) {
            vscode.window.showErrorMessage('No workspace folder is open.');
            isIndexing = false;
            return;
        }
        
        // Get configuration
        const config = vscode.workspace.getConfiguration('wscode');
        const maxFiles = config.get('maxIndexedFiles') || 1000;
        const includePattern = config.get('fileExtensionsToIndex') || "**/*.{js,ts,py,java,md,html,css,json}";
        const excludePattern = config.get('excludeFromIndex') || "**/node_modules/**,**/dist/**,**/build/**,**/.git/**";
        
        // Find files in workspace
        const excludePatterns = excludePattern.split(',');
        const files = await vscode.workspace.findFiles(includePattern, `{${excludePatterns.join(',')}}`, maxFiles);
        
        console.log(`[WSCode] Found ${files.length} files to index.`);
        
        // Read file contents
        const fileContents = {};
        let progress = 0;
        
        for (const file of files) {
            try {
                const contentBytes = await vscode.workspace.fs.readFile(file);
                const content = Buffer.from(contentBytes).toString('utf8');
                
                // Store file content
                const relativePath = vscode.workspace.asRelativePath(file);
                fileContents[relativePath] = content;
                
                // Update progress
                progress++;
                if (progress % 10 === 0) {
                    vscode.window.setStatusBarMessage(`Indexing workspace: ${progress}/${files.length} files processed`, 1000);
                }
            } catch (error) {
                console.warn(`[WSCode] Error reading file ${file.fsPath}: ${error}`);
            }
        }
        
        // Create embeddings for each file
        const embeddings = [];
        const filePaths = Object.keys(fileContents);
        
        for (const filePath of filePaths) {
            const content = fileContents[filePath];
            const embedding = createSimpleEmbedding(content);
            embeddings.push(embedding);
        }
        
        // Create HNSW index
        const dimensions = 128; // Dimension of our embeddings
        const maxElements = filePaths.length;
        
        try {
            const index = new hnswlib.HierarchicalNSW("l2", dimensions);
            index.initIndex(maxElements, 16, 200, 100);
            
            // Add embeddings to index
            for (let i = 0; i < embeddings.length; i++) {
                // Convert Float32Array to regular array for compatibility
                const embeddingArray = Array.from(embeddings[i]);
                index.addPoint(embeddingArray, i);
            }
            
            // Save index and embeddings
            workspaceIndex = index;
            workspaceEmbeddings = embeddings.map(emb => Array.from(emb)); // Convert all to regular arrays
            workspaceFileContents = fileContents;
        } catch (error) {
            console.error('[WSCode] Error creating HNSW index:', error);
            throw new Error(`Error creating vector index: ${error.message}`);
        }
        
        // Store in workspace state
        await context.workspaceState.update(workspaceIndexKey, true);
        await context.workspaceState.update(workspaceEmbeddingsKey, workspaceEmbeddings); // Use the converted embeddings
        await context.workspaceState.update(workspaceFileContentsKey, workspaceFileContents);
        
        vscode.window.showInformationMessage(`Workspace indexing complete. Indexed ${filePaths.length} files.`);
    } catch (error) {
        console.error('[WSCode] Error indexing workspace:', error);
        vscode.window.showErrorMessage(`Error indexing workspace: ${error.message}`);
    } finally {
        isIndexing = false;
    }
}

// Function to clear workspace index
async function clearWorkspaceIndex(context) {
    try {
        workspaceIndex = null;
        workspaceEmbeddings = null;
        workspaceFileContents = null;
        
        await context.workspaceState.update(workspaceIndexKey, undefined);
        await context.workspaceState.update(workspaceEmbeddingsKey, undefined);
        await context.workspaceState.update(workspaceFileContentsKey, undefined);
        
        vscode.window.showInformationMessage('Workspace index cleared.');
    } catch (error) {
        console.error('[WSCode] Error clearing workspace index:', error);
        vscode.window.showErrorMessage(`Error clearing workspace index: ${error.message}`);
    }
}

// Function to load workspace index from workspace state
async function loadWorkspaceIndex(context) {
    try {
        const isIndexed = context.workspaceState.get(workspaceIndexKey);
        if (!isIndexed) {
            return false;
        }
        
        workspaceEmbeddings = context.workspaceState.get(workspaceEmbeddingsKey);
        workspaceFileContents = context.workspaceState.get(workspaceFileContentsKey);
        
        if (!workspaceEmbeddings || !workspaceFileContents) {
            return false;
        }
        
        // Recreate HNSW index
        const dimensions = 128;
        const maxElements = Object.keys(workspaceFileContents).length;
        
        try {
            workspaceIndex = new hnswlib.HierarchicalNSW("l2", dimensions);
            workspaceIndex.initIndex(maxElements, 16, 200, 100);
            
            // Add embeddings to index
            for (let i = 0; i < workspaceEmbeddings.length; i++) {
                // Make sure we're using regular arrays, not Float32Array
                const embedding = Array.isArray(workspaceEmbeddings[i]) 
                    ? workspaceEmbeddings[i] 
                    : Array.from(workspaceEmbeddings[i]);
                    
                workspaceIndex.addPoint(embedding, i);
            }
            
            console.log(`[WSCode] Loaded workspace index with ${workspaceEmbeddings.length} files.`);
            return true;
        } catch (error) {
            console.error('[WSCode] Error recreating HNSW index:', error);
            // Clear the corrupted index
            await clearWorkspaceIndex(context);
            return false;
        }
    } catch (error) {
        console.error('[WSCode] Error loading workspace index:', error);
        return false;
    }
}

async function getEditorContent() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        return null;
    }

    const document = editor.document;
    const selection = editor.selection;

    if (!selection.isEmpty) {
        return document.getText(selection);
    } else {
        return document.getText();
    }
}

function getWorkspaceIdentifier() {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        return "default_workspace";
    }
    return workspaceFolders[0].uri.fsPath.replace(/[^a-zA-Z0-9]/g, '_');
}

async function getStorageFilePath(context) {
    const workspaceId = getWorkspaceIdentifier();
    const storagePath = context.globalStorageUri.fsPath;
    try {
        await fs.mkdir(storagePath, { recursive: true });
    } catch (error) {
        console.error('Error creating storage directory:', error);
        return null;
    }
    return path.join(storagePath, `${workspaceId}_chat.html`);
}

async function storeChatToFile(context, chat) {
    const filePath = await getStorageFilePath(context);
    if (!filePath) {
        return;
    }
    await fs.writeFile(filePath, chat, 'utf8');
}

async function retrieveChatFromFile(context) {
    const filePath = await getStorageFilePath(context);
    const workspaceId = getWorkspaceIdentifier();
    if (!filePath) {
        return null;
    }
    try {
        return await fs.readFile(filePath, 'utf8');
    } catch (error) {
        console.error(`Error reading chat from file (workspace: ${workspaceId}):`, error);
        return null;
    }
}

// Function to handle conversation with Cerebras API using tools
async function handleUserQuery(userQuestion, context) {
    const apiKey = vscode.workspace.getConfiguration('wscode').get('apiKey');
    if (!apiKey) {
        vscode.window.showErrorMessage('API Key not set. Use the "WSCode: Setup API Key for Cerebras Inference" command to set the API Key.');
        return;
    }
    
    // Check if workspace is indexed
    if (!workspaceIndex || !workspaceEmbeddings || !workspaceFileContents) {
        const isIndexed = await loadWorkspaceIndex(context);
        if (!isIndexed) {
            console.log('[WSCode] Workspace is not indexed. Tool-based search will not work.');
            vscode.window.showInformationMessage('Workspace is not indexed. Run "WSCode: Index Workspace for Context" for better results.');
        } else {
            console.log(`[WSCode] Workspace index loaded with ${Object.keys(workspaceFileContents).length} files.`);
        }
    }
    
    // Initialize conversation history with system message
    let conversationHistory = [
        { 
            role: 'system', 
            content: `You are an advanced AI coding assistant integrated into VS Code. 
You have access to tools that can help you answer the user's questions more effectively.

IMPORTANT: For almost all coding questions, you should first use the findRelevantContext tool to search the user's codebase for relevant information. This will help you provide more accurate and contextual answers.

When using the findRelevantContext tool:
1. Use specific keywords from the user's question
2. Try to search for file names, function names, or specific code patterns
3. If the first search doesn't yield useful results, try a more general search

Think step-by-step to answer the user's question accurately and concisely.
Always reference relevant code from the user's codebase when it helps answer their question.
When you find relevant code, explain how it works and how it relates to the user's question.`
        },
        { role: 'user', content: userQuestion }
    ];
    
    // Set up tool definitions
    const toolDefinitions = getToolDefinitions();
    
    // Maximum number of tool call turns to prevent infinite loops
    const maxTurns = 5;
    let turn = 0;
    
    while (turn < maxTurns) {
        turn++;
        
        try {
            // Call Cerebras API
            const client = new Cerebras({ apiKey: apiKey });
            // Set a timeout for the API call
            const timeoutMs = 60000; // 60 seconds
            const timeoutPromise = new Promise((_, reject) => 
                setTimeout(() => reject(new Error('API request timed out after 60 seconds')), timeoutMs)
            );
            
            // Race the API call against the timeout
            const chatCompletion = await Promise.race([
                client.chat.completions.create({
                    model: selectedModel,
                    messages: conversationHistory,
                    tools: toolDefinitions,
                    tool_choice: "auto"
                }),
                timeoutPromise
            ]);
            
            const assistantMessage = chatCompletion.choices[0].message;
            
            // Check if the assistant wants to use tools
            if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
                console.log(`[WSCode] Tool calls requested: ${assistantMessage.tool_calls.length}`);
                for (const toolCall of assistantMessage.tool_calls) {
                    console.log(`[WSCode] Tool call: ${toolCall.function.name} with args: ${toolCall.function.arguments}`);
                }
                
                // Add assistant's tool call message to history
                conversationHistory.push({
                    role: 'assistant',
                    content: assistantMessage.content,
                    tool_calls: assistantMessage.tool_calls
                });
                
                // Execute each tool call
                for (const toolCall of assistantMessage.tool_calls) {
                    const toolResult = await executeToolCall(toolCall, context);
                    
                    // Add tool result to conversation history
                    conversationHistory.push({
                        role: 'tool',
                        tool_call_id: toolCall.id,
                        content: toolResult
                    });
                }
                
                // Continue to next turn (will call API again with updated history)
                continue;
            }
            
            // If no tool calls, we have our final answer
            const finalResponse = assistantMessage.content;
            const time = chatCompletion.time_info?.completion_time || 0;
            const totalTokens = chatCompletion.usage?.completion_tokens || 1;
            const tokensPerSecond = time > 0 ? totalTokens / time : 0;
            
            // Format and display the response
            const formattedResponse = extractCodeFromFence(finalResponse);
            cerebrasInferenceWebview.postMessage({
                type: 'addResponse',
                value: formattedResponse,
                tokensPerSecond: Math.floor(tokensPerSecond)
            });
            
            // Exit the loop as we have our answer
            return;
        } catch (err) {
            console.error('[WSCode] API Error:', err);
            cerebrasInferenceWebview.postMessage({ type: 'handleError' });
            
            // Check if we have any tool results we can use to provide a partial response
            if (conversationHistory.length > 2) {
                const toolResults = conversationHistory.filter(msg => msg.role === 'tool');
                if (toolResults.length > 0) {
                    // We have some tool results, let's provide a partial response
                    let partialResponse = "I encountered an error while processing your request, but I found these relevant files in your codebase:\n\n";
                    
                    for (const toolResult of toolResults) {
                        if (toolResult.content && toolResult.content.includes("Relevant files found")) {
                            partialResponse += toolResult.content;
                        }
                    }
                    
                    partialResponse += "\n\nPlease try your question again or rephrase it.";
                    
                    const formattedResponse = extractCodeFromFence(partialResponse);
                    cerebrasInferenceWebview.postMessage({
                        type: 'addResponse',
                        value: formattedResponse,
                        tokensPerSecond: 0
                    });
                    return;
                }
            }
            
            // Handle specific error types
            if (err instanceof Cerebras.APIError) {
                if (err.status == 400 && err.error && err.error.code === "context_length_exceeded") {
                    vscode.window.showWarningMessage(`Context length exceeded. Trying with reduced context.`);
                    // Simplify the conversation history to reduce context length
                    conversationHistory = [{ role: 'user', content: userQuestion }];
                } else {
                    vscode.window.showErrorMessage(`API Error: ${err.message}`);
                    
                    // Show error in chat
                    cerebrasInferenceWebview.postMessage({
                        type: 'addResponse',
                        value: marked(`Error communicating with Cerebras API: ${err.message}\n\nPlease try again later.`),
                        tokensPerSecond: 0
                    });
                    return;
                }
            } else {
                vscode.window.showErrorMessage(`Error: ${err.message}`);
                
                // Show error in chat
                cerebrasInferenceWebview.postMessage({
                    type: 'addResponse',
                    value: marked(`Error: ${err.message}\n\nPlease try again later.`),
                    tokensPerSecond: 0
                });
                return;
            }
        }
    }
    
    // If we reach here, we've exceeded the maximum number of turns
    vscode.window.showWarningMessage('Exceeded maximum number of tool calls. Please try a simpler query.');
    cerebrasInferenceWebview.postMessage({
        type: 'addResponse',
        value: marked("I'm having trouble processing your request due to too many tool calls. Please try a simpler query or be more specific."),
        tokensPerSecond: 0
    });
}

// Legacy function for backward compatibility
async function callCerebrasApi(apiKey, prompt, editorContent) {
    let messages = [];
    
    // Create system message with Chain-of-Thought instructions
    const systemMessage = `You are an advanced AI coding assistant integrated into VS Code. 
Think step-by-step to answer the user's question accurately and concisely.
Use the provided code context ONLY if it is relevant to the user's question.`;
    
    messages.push({ role: 'system', content: systemMessage });
    
    if (editorContent) {
        messages.push({ 
            role: 'user', 
            content: `Here is the code from my current file for context:\n\`\`\`\n${editorContent}\n\`\`\`\n\nMy question is: ${prompt}` 
        });
    } else {
        messages.push({ role: 'user', content: prompt });
    }

    const client = new Cerebras({ apiKey: apiKey });
    try {
        // Set a timeout for the API call
        const timeoutMs = 60000; // 60 seconds
        const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('API request timed out after 60 seconds')), timeoutMs)
        );
        
        // Race the API call against the timeout
        const chatCompletion = await Promise.race([
            client.chat.completions.create({
                messages: messages,
                model: selectedModel,
            }),
            timeoutPromise
        ]);
        
        if (chatCompletion) {
            const code = extractCodeFromFence(chatCompletion.choices[0].message.content);
            const time = chatCompletion.time_info?.completion_time || 0;
            const totalTokens = chatCompletion.usage?.completion_tokens || 1;
            const tokensPerSecond = time > 0 ? totalTokens / time : 0;
            cerebrasInferenceWebview.postMessage({
                type: 'addResponse',
                value: code,
                tokensPerSecond: Math.floor(tokensPerSecond)
            });
        }
        
        return chatCompletion;
    } catch (err) {
        console.error('[WSCode] API Error in legacy mode:', err);
        cerebrasInferenceWebview.postMessage({ type: 'handleError' });
        
        if (err instanceof Cerebras.APIError) {
            if (err.status == 400 && err.error && err.error.code === "context_length_exceeded") {
                vscode.window.showWarningMessage(`The length of editor content or highlighted area exceeded limit. Trying again without them.`);
                await callCerebrasApi(apiKey, prompt, null);
            } else {
                vscode.window.showErrorMessage(`API Error: ${err.message}`);
                
                // Show error in chat
                cerebrasInferenceWebview.postMessage({
                    type: 'addResponse',
                    value: marked(`Error communicating with Cerebras API: ${err.message}\n\nPlease try again later.`),
                    tokensPerSecond: 0
                });
            }
        } else {
            vscode.window.showErrorMessage(`Error: ${err.message}`);
            
            // Show error in chat
            cerebrasInferenceWebview.postMessage({
                type: 'addResponse',
                value: marked(`Error: ${err.message}\n\nPlease try again later.`),
                tokensPerSecond: 0
            });
        }
        
        return null;
    }

}

async function postQuestion(prompt, context) {
    if (!cerebrasInferenceWebview) {
        vscode.window.showErrorMessage('Could not find the Cerebras Inference webview.');
        return;
    }

    const apiKey = vscode.workspace.getConfiguration('wscode').get('apiKey');
    if (!apiKey) {
        vscode.window.showErrorMessage('API Key not set. Use the "WSCode: Setup API Key for Cerebras Inference" command to set the API Key.');
        return;
    }

    cerebrasInferenceWebview.postMessage({ type: 'addQuestion', value: prompt });

    // Always try to load the workspace index if it's not already loaded
    if (!workspaceIndex || !workspaceEmbeddings || !workspaceFileContents) {
        await loadWorkspaceIndex(context);
    }
    
    // Check if workspace is now indexed
    const isWorkspaceIndexed = workspaceIndex !== null && 
                              workspaceEmbeddings !== null && 
                              workspaceFileContents !== null;
    
    console.log(`[WSCode] Workspace indexed: ${isWorkspaceIndexed}`);
    
    // Use the new tool-based approach if workspace is indexed, otherwise fall back to the legacy approach
    if (isWorkspaceIndexed) {
        await handleUserQuery(prompt, context);
    } else {
        console.log('[WSCode] Using legacy approach without tools');
        const editorContent = await getEditorContent();
        await callCerebrasApi(apiKey, prompt, editorContent);
    }
}

function extractCodeFromFence(text) {
    const htmlMatch = text.match(/```html\n([\s\S]*?)\n```/);
    const md = htmlMatch ? htmlMatch[1].trim() : text;
    const html = marked(md);
    return html;
}

async function setupApiKey() {
    const currentApiKey = vscode.workspace.getConfiguration('wscode').get('apiKey');
    const apiKey = await vscode.window.showInputBox({ value: currentApiKey, prompt: "Enter your API Key for Cerebras Inference" }) || "";
    if (apiKey) {
        await vscode.workspace.getConfiguration('wscode').update('apiKey', apiKey, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage('API Key has been set.');
        return apiKey;
    } else {
        await vscode.workspace.getConfiguration('wscode').update('apiKey', "", vscode.ConfigurationTarget.Global);
        vscode.window.showErrorMessage('API Key not set.');
        return null;
    }
}

async function getWebviewContent(context, webview) {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'main.js'));
    const stylesMainUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'main.css'));
    const prismJsUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'prism.js'));
    const prismCssUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'prism.css'));
    const tailwindUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'tailwind.js'));
    const historyHtml = await retrieveChatFromFile(context) || "";

    const html = `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <link href="${prismCssUri}" rel="stylesheet">
            <link href="${stylesMainUri}" rel="stylesheet">
            <script src="${tailwindUri}"></script>
        </head>
        <body class="overflow-hidden">
            <div class="mx-auto flex w-full items-center justify-between mb-6">
                <div class="flex items-center gap-x-2">
                </div>

                <div class="flex items-center gap-x-2">
                    <div class="hidden">
                        <button data-testid="dropdown-button" class="min-w-40 w-full px-3 bg-neutral border border-neutral-20 rounded-md shadow flex justify-between items-center text-md text-neutral-95 outline-none hover:bg-interactive-5 hover:border-neutral-15 focus:border-2 focus:border-interactive-50 h-9" type="button" id="radix-:r0:" aria-haspopup="menu" aria-expanded="false" data-state="closed"><div class="max-w-[80%] truncate">Llama3.1-8B</div><svg class="max-sm:w-3 max-sm:h-3 max-md:w-4 max-md:h-4 w-5 h-5 max-sm:stroke-[1.6667px] max-md:stroke-[1.5625px] stroke-1.5 shrink-0" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" stroke="currentColor" role="img" aria-label="expand icon"><path d="M5 7.5L10 12.5L15 7.5" stroke-linecap="round" stroke-linejoin="round"></path></svg></button>
                    </div>
                    <button type="button" class="h-9 text-md-b px-3 py-0 rounded-md shadow outline-none focus:ring-0 relative flex justify-center items-center bg-neutral text-neutral-95 border border-neutral-15 hover:bg-interactive-10 focus:border-2 focus:border-interactive-50 active:border-neutral-50 active:shadow-none focus:active:bg-neutral focus:active:border-neutral-50 focus:px-[15px]" data-testid="clear-button" id="clear-button"><svg class="w-4 h-4 stroke-[1.5625px]" viewBox="0 0 20 20" fill="none" stroke="currentColor" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="clear icon"><path d="M5.83333 17.5L2.25 13.9166C1.41667 13.0833 1.41667 11.8333 2.25 11.0833L10.25 3.08331C11.0833 2.24998 12.3333 2.24998 13.0833 3.08331L17.75 7.74998C18.5833 8.58331 18.5833 9.83331 17.75 10.5833L10.8333 17.5" stroke-linecap="round" stroke-linejoin="round"></path><path d="M18.3333 17.5H5.83333" stroke-linecap="round" stroke-linejoin="round"></path><path d="M4.16667 9.16669L11.6667 16.6667" stroke-linecap="round" stroke-linejoin="round"></path></svg><span class="ml-1.5 max-sm:hidden">Clear</span></button>
                    <div class="bg-neutral-90 fixed inset-0 z-40 bg-opacity-80 transition-opacity hidden opacity-0"></div>
                    <div class="bg-neutral-90 fixed inset-0 z-40 bg-opacity-80 transition-opacity hidden opacity-0"></div>
                </div>
            </div>
            <div class="flex flex-col h-screen">
                <div class="flex-1 overflow-y-auto" id="message-list">${historyHtml}</div>
                <div id="in-progress" class="p-4 flex items-center hidden">
                    <div style="text-align: center;">
                        <div>Brainstorming...</div>
                        <div class="loader"></div>
                    </div>
                </div>
                <div class="relative shrink-0 leading-none mb-[114px] mt-6">
                    <textarea data-testid="chat-textarea" placeholder="Ask anything..." id="question-input" class="text-lg w-full inline-flex px-4 focus:px-[15px] bg-neutral border-neutral-15 focus:outline-none focus:ring-0 text-neutral-95 hover:bg-interactive-10 hover:border-neutral-15 active:border-interactive-50 active:rounded-lg focus:rounded-lg focus:border-interactive-50 placeholder:text-neutral-45 rounded-lg min-h-11 resize-none py-[11px] focus:py-[10px] border focus:border-2 active:border-2 shadow h-[84px] pr-9 focus:pr-9" style="height: 84px;"></textarea>
                    <div class="absolute right-[0px] bottom-[-42px] flex items-center gap-2">
                        <select id="model-selection-dropdown" class="h-9 text-md-b px-3 py-0 rounded-md shadow outline-none items-center focus:ring-0 bg-neutral text-neutral-95 border border-neutral-15 hover:bg-interactive-10 focus:border-2 focus:border-interactive-50 active:border-neutral-50 active:shadow-none focus:active:bg-neutral focus:active:border-neutral-50">
                            <option value="llama3.1-8b">Llama 3.1 8B</option>
                            <option value="llama-3.3-70b" selected>Llama 3.3 70B</option>
                        </select>
                        <button id="ask-button" class="h-9 text-md-b px-3 py-0 rounded-md shadow outline-none items-center focus:ring-0 bg-neutral text-neutral-95 border border-neutral-15 hover:bg-interactive-10 focus:border-2 focus:border-interactive-50 active:border-neutral-50 active:shadow-none focus:active:bg-neutral focus:active:border-neutral-50 focus:px-[15px]"><span class=""><svg class="w-4 h-4 stroke-[1.5625px]" viewBox="0 0 20 20" fill="none" stroke="currentColor" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="send icon"><path d="M2.5 2.5L5 10L2.5 17.5L18.3333 10L2.5 2.5Z" stroke-linecap="round" stroke-linejoin="round"></path><path d="M5 10H18.3333" stroke-linecap="round" stroke-linejoin="round"></path></svg></span></button>
                    </div>
                </div>
            </div>
            <script src="${prismJsUri}"></script>
            <script src="${scriptUri}"></script>
        </body>
        </html>`;

    return html;
}

// This method is called when your extension is deactivated
function deactivate() {}

module.exports = {
    activate,
    deactivate
}
