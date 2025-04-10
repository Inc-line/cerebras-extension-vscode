# Implementing Codebase Context and Chain-of-Thought (CoT)

Let's break down how we can implement a feature that uses the codebase as context, potentially incorporating Chain-of-Thought (CoT) principles, within our VS Code extension.

This proposal touches on several concepts:

*   **Codebase Context:** Making the LLM aware of the user's code.
*   **Vector Embeddings/Search:** Storing and retrieving relevant code snippets efficiently (implied by "in-memory vector"). This is essentially Retrieval-Augmented Generation (RAG).
*   **Context Management:** Handling the LLM's limited context window.
*   **Chain-of-Thought (CoT):** Guiding the LLM to reason step-by-step.
*   **State Persistence:** Saving context/history (context provider).

We can combine these ideas. A practical approach is to use RAG to find relevant code snippets and then use CoT prompting techniques when sending the query and context to the Cerebras API.

Here's a breakdown of how we could implement this in `extension.js`:

## 1. Gathering Codebase Context (On Demand or Indexing)

We have two main options for getting code context:

*   **Option A: Simple (Active File/Selection + Manual Find):** Use the currently active file or selection (as we already do) and potentially add a command to let the user explicitly select other relevant files. This is less automatic but avoids heavy processing.

*   **Option B: Indexing (More Complex, Closer to this Proposal):** Scan the workspace, potentially chunk files, and create an index for retrieval.

    *   **Scanning Files:** Use the VS Code workspace API.

        ```javascript
        // Inside our activate function or a dedicated command handler
        async function getAllCodeFiles() {
            // Exclude node_modules, build outputs, etc. Use our .gitignore patterns if possible.
            const excludePattern = '**/node_modules/**';
            // Include common code file extensions
            const includePattern = '**/*.{js,ts,py,java,md,html,css,json}'; // Adjust as needed

            console.log('[Cerebras] Scanning workspace files...');
            const files = await vscode.workspace.findFiles(includePattern, excludePattern, 1000); // Limit max results
            console.log(`[Cerebras] Found ${files.length} potential files.`);

            const fileContents = {};
            for (const file of files) {
                try {
                    const contentBytes = await vscode.workspace.fs.readFile(file);
                    const content = Buffer.from(contentBytes).toString('utf8');
                    // Simple storage: map file path to content
                    fileContents[file.fsPath] = content.substring(0, 5000); // Limit content length per file initially
                } catch (err) {
                    console.warn(`[Cerebras] Error reading file ${file.fsPath}: ${err}`);
                }
            }
            console.log('[Cerebras] Finished reading file contents.');
            return fileContents; // This is a simple key-value store, not yet a vector DB
        }

        // We might store this in memory (careful with large workspaces)
        // let workspaceCodeContext = {};
        // vscode.commands.registerCommand('wscode.indexWorkspace', async () => {
        //     vscode.window.showInformationMessage('Indexing workspace...');
        //     workspaceCodeContext = await getAllCodeFiles();
        //     vscode.window.showInformationMessage(`Workspace indexing complete. Found ${Object.keys(workspaceCodeContext).length} files.`);
        // });
        ```

    *   **Vector Embeddings (Advanced):** To implement true vector search, we'd need:
        *   A way to generate embeddings (e.g., using a library like `transformers.js` locally, or potentially a Cerebras embedding endpoint if available).
        *   A vector store (e.g., an in-memory library like `hnswlib-node` or a simple array search for smaller projects).
        *   This adds significant complexity and dependencies. **Recommendation:** Start without vector embeddings first. Use keyword matching or just provide context from explicitly selected/active files.

## 2. Retrieving Relevant Context (RAG)

If we've indexed (Option B), we need to retrieve relevant parts when the user asks a question.

```javascript
function findRelevantContext(query, workspaceCodeContext) {
    // Simple Keyword Matching Example (replace with vector search if implemented)
    const queryLower = query.toLowerCase();
    const relevantSnippets = [];
    let currentLength = 0;
    const maxLength = 4000; // Max characters for retrieved context

    for (const filePath in workspaceCodeContext) {
        const content = workspaceCodeContext[filePath];
        const contentLower = content.toLowerCase();
        if (contentLower.includes(queryLower)) { // Very basic matching
            const snippet = `// File: ${filePath}\n${content.substring(0, 500)}\n...\n`; // Get a preview
            if (currentLength + snippet.length <= maxLength) {
                relevantSnippets.push(snippet);
                currentLength += snippet.length;
            } else {
                break; // Stop adding if context gets too long
            }
        }
    }
    return relevantSnippets.join('\n');
}
```

## 3. Modifying the Prompt for Chain-of-Thought

When we construct the prompt to send to the Cerebras API, explicitly ask it to think step-by-step.

```javascript
// Inside the function that prepares the API request (e.g., within askCerebras or similar)

async function preparePromptForApi(userQuestion, conversationHistory, activeEditorContext, retrievedWorkspaceContext) {
    let prompt = `You are a helpful AI assistant integrated into VS Code.
Think step-by-step to answer the user's question accurately and concisely.
Use the provided code context ONLY if it is relevant to the user's question.

Conversation History:
${formatHistory(conversationHistory)}

Code Context from Active Editor/Selection:
\`\`\`
${activeEditorContext || "No active editor context provided."}
\`\`\`
`;

    if (retrievedWorkspaceContext) {
        prompt += `\nPotentially Relevant Code Context from Workspace:\n\`\`\`\n${retrievedWorkspaceContext}\n\`\`\`\n`;
    }

    prompt += `\nUser Question: ${userQuestion}\n\nAssistant's Step-by-Step Thought Process and Final Answer:`;

    // --- Context Length Management ---
    // We MUST ensure the final prompt string doesn't exceed the model's limit.
    // Implement truncation logic here if necessary (e.g., shorten history, context).
    const MAX_PROMPT_LENGTH = 8000; // Example limit - check Cerebras docs
    if (prompt.length > MAX_PROMPT_LENGTH) {
        console.warn('[Cerebras] Prompt exceeds max length, truncating...');
        // Add logic here to intelligently shorten parts of the prompt
        prompt = prompt.substring(0, MAX_PROMPT_LENGTH);
    }

    return prompt;
}

// Helper to format history (adapt based on how we store it)
function formatHistory(history) {
    return history.map(item => `${item.role}: ${item.content}`).join('\n');
}

// --- In our main ask function ---
// Assuming we have access to conversationHistory, activeContext
// And potentially workspaceCodeContext if using indexing

// let retrievedContext = "";
// if (Object.keys(workspaceCodeContext).length > 0) { // Check if index exists
//     retrievedContext = findRelevantContext(userQuestion, workspaceCodeContext);
// }

// const finalPrompt = await preparePromptForApi(userQuestion, conversationHistory, activeContext, retrievedContext);

// const response = await makeCerebrasApiCall(finalPrompt, apiKey, selectedModel);
```

## 4. Managing State ("Context Provider")

VS Code's `ExtensionContext` provides `workspaceState` and `globalState` for persistence.

*   `workspaceState`: Good for storing conversation history specific to the current workspace.
*   `globalState`: Good for storing the API key.

```javascript
// In activate(context)
const historyStorageKey = `cerebrasChatHistory_${vscode.workspace.name || 'global'}`;

// Load history on activation
let conversationHistory = context.workspaceState.get(historyStorageKey) || [];

// Save history after each successful interaction
async function saveHistory(context, history) {
    await context.workspaceState.update(historyStorageKey, history);
}

// --- After receiving a response from the API ---
// Add user question and AI response to conversationHistory
// conversationHistory.push({ role: 'user', content: userQuestion });
// conversationHistory.push({ role: 'assistant', content: aiResponse });

// // Limit history length to prevent excessive storage/context use
// const MAX_HISTORY_ITEMS = 20;
// if (conversationHistory.length > MAX_HISTORY_ITEMS) {
//     conversationHistory = conversationHistory.slice(-MAX_HISTORY_ITEMS);
// }

// await saveHistory(context, conversationHistory);
```

## Summary of Changes:

1.  **Decide on Context Strategy:** Simple active/selected files or more complex workspace indexing.
2.  **(If Indexing):** Implement `getAllCodeFiles` and potentially a retrieval function like `findRelevantContext`. Add a command to trigger indexing. Be mindful of performance and memory.
3.  **Modify Prompt:** Update `preparePromptForApi` to include:
    *   An explicit "Think step-by-step" instruction.
    *   Placeholders for different context types (active editor, retrieved workspace).
    *   Robust context length management/truncation *before* sending to the API.
4.  **Integrate Retrieval:** Call our context retrieval function before preparing the prompt.
5.  **Use `workspaceState`:** Load and save conversation history using `context.workspaceState` to persist it per workspace, effectively acting as our "context provider" for history.

Start with the simpler context approach (active file/selection) and the CoT prompt modification first. Then, if needed, explore workspace indexing and retrieval, keeping the complexity trade-offs in mind.
