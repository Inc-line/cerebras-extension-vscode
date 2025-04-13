# WSCode

WSCode is an unofficial extension that enables you to chat with Cerebras Inference directly within VSCode.

## Features

![2538 T/s](resources/2538tps.png)

- Directly chat with Cerebras Inference
- Switch between Llama 3.1 8B and Llama 3.3 70B models
- Provide currently open file or selected text to the context window
- **NEW:** Chain-of-Thought reasoning for more accurate responses
- **NEW:** Workspace indexing for codebase-aware context using vector search

## Requirements

Get an API key from https://cloud.cerebras.ai/, then set it using `WSCode: Setup API Key for Cerebras Inference` command.

## Extension Settings

This extension contributes the following settings:

* `wscode.setupApiKey`: Setup API key.
* `wscode.ask`: Ask anything.
* `wscode.indexWorkspace`: Index your workspace to enable codebase-aware context.
* `wscode.clearWorkspaceIndex`: Clear the workspace index.
* `wscode.maxIndexedFiles`: Maximum number of files to index (default: 1000).
* `wscode.fileExtensionsToIndex`: File patterns to include in workspace indexing (glob pattern).
* `wscode.excludeFromIndex`: Patterns to exclude from workspace indexing.
* `wscode.maxContextLength`: Maximum length of context to send to Cerebras API.

## Using Workspace Indexing

1. Open your project in VS Code
2. Run the command `WSCode: Index Workspace for Context`
3. Wait for indexing to complete (status will be shown in the status bar)
4. Ask questions about your codebase!

The extension will automatically use the indexed codebase to provide relevant context to the AI when answering your questions. This enables the AI to understand your project structure and provide more accurate answers.

## Chain-of-Thought Reasoning

The extension now uses Chain-of-Thought prompting techniques to guide the AI to think step-by-step when answering your questions. This results in more accurate and well-reasoned responses, especially for complex coding questions.

## Known Issues

The context window for your API key varies by tier and may be capped at 8192 tokens.
Large files could exceed this limit.
If that happens, open a blank file or select a relevant portion of the file to continue.

Workspace indexing uses a simple vector search implementation. For very large codebases, consider adjusting the `wscode.maxIndexedFiles` setting to limit memory usage.

## Disclaimer

This is NOT an official extension. Cerebras Inference is a trademark of Cerebras Systems Inc.
