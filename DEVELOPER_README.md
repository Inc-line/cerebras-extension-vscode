# Developer README: Cerebras Inference VS Code Extension (wscode)

This document provides instructions for developers working on the Cerebras Inference VS Code extension.

## Overview

This VS Code extension provides an interface to interact with the Cerebras Inference API. It allows users to:

*   Ask questions directly within VS Code.
*   Optionally use the content of the active editor or selection as context for the questions.
*   View the conversation history within a dedicated webview panel.
*   Select different Cerebras models for inference.
*   Configure their Cerebras API key.
*   Persist chat history per workspace.

## Prerequisites

*   [Node.js](https://nodejs.org/) (which includes npm) - LTS version recommended.
*   [Visual Studio Code](https://code.visualstudio.com/)

## Setup

1.  **Clone the repository:**
    ```bash
    git clone <your-repository-url>
    cd cerebras-extension-vscode
    ```
2.  **Install dependencies:**
    ```bash
    npm install
    ```

## Configuration

The extension requires a Cerebras API key to function.

1.  **Obtain an API Key:** Get your API key from Cerebras.
2.  **Set the API Key:**
    *   **Using the Command:** Run the VS Code command `WSCode: Setup API Key for Cerebras Inference` (Ctrl+Shift+P or Cmd+Shift+P, then type the command name). Enter your key when prompted.
    *   **Using VS Code Settings:** Go to File > Preferences > Settings (or Code > Settings > Settings on macOS). Search for `wscode.apiKey` and enter your key there.

The API key is stored globally in your VS Code settings.

## Running and Debugging the Extension

To run the extension locally for manual testing and debugging:

1.  **Open the project folder** (`cerebras-extension-vscode`) in your main VS Code window.
2.  **Start the Debugger:**
    *   Press `F5`.
    *   *Alternatively:* Go to the **Run and Debug** view in the Activity Bar (the icon with a play button and bug, or Ctrl+Shift+D / Cmd+Shift+D). Ensure the dropdown at the top is set to **"Run Extension"** and click the green play button.
3.  **Extension Development Host:** This launches a *new* VS Code window called the "[Extension Development Host]". Your extension is automatically loaded and activated within this new window. This window will stay open for manual testing.
4.  **Test Features:** Interact with your extension's features (commands, UI elements, webview) inside the **Extension Development Host** window.
5.  **View Logs and Debug:**
    *   Switch back to your **original** VS Code window (where you pressed F5).
    *   Open the **Panel** area at the bottom (View > Appearance > Panel, or Ctrl+J / Cmd+J).
    *   Select the **"DEBUG CONSOLE"** tab within the panel. All `console.log` output from your extension (`extension.js`) will appear here.
    *   You can set breakpoints in your code (`extension.js`, etc.) in the original window. Execution will pause when the code is hit in the Extension Development Host.
6.  **Filtering Debug Output:**
    *   The Debug Console can show logs from multiple sources (including other extensions). To focus on *your* extension's output, use the **"Filter"** input box located within the Debug Console tab (usually top-right of the console content area).
    *   Type a term unique to your extension's logs into the filter box.
    *   **Tip:** For easier filtering, consider adding a consistent prefix to your extension's log messages, like `console.log("[Cerebras] Some message...")`, and then filter by `[Cerebras]`.

## Running Automated Tests

The project includes an automated test suite. *Note: This is different from running for manual debugging.*

1.  **Run tests:**
    ```bash
    npm run test
    ```
    This command first runs the linter (`npm run lint`) and then executes the tests using `vscode-test`. It briefly launches and closes an Extension Development Host window automatically to run the tests defined in `src/test/`. Test results are printed to the console where you ran the command.

## Linting

ESLint is used to maintain code quality and consistency.

1.  **Run the linter:**
    ```bash
    npm run lint
    ```
    This will check the codebase according to the rules defined in `eslint.config.mjs` and report any warnings or errors. See the `ESLINT_Configuration.md` guide for details on resolving environment-specific warnings (like `no-undef` in `media/` files).

## Packaging

To create an installable `.vsix` package of the extension:

1.  **Run the package script:**
    ```bash
    npm run package
    ```
    This uses the `vsce` (Visual Studio Code Extensions) tool to bundle the extension into a `.vsix` file (e.g., `wscode-0.9.8.vsix`) in the project root.

    *Note:* Consider using a bundler like `webpack` or `esbuild` and refining your `.vscodeignore` file for optimized performance and smaller package size before publishing.

## Code Structure

*   `extension.js`: The main activation point for the extension backend (Node.js environment).
*   `media/`: Frontend assets for the webview panel (Browser-like environment).
    *   `main.js`: Webview UI logic.
    *   `main.css`: Webview styles.
    *   `prism.js`/`prism.css`: Syntax highlighting library.
    *   `tailwind.js`: Tailwind CSS utility classes.
*   `package.json`: Extension manifest file.
*   `eslint.config.mjs`: ESLint configuration.
*   `resources/`: Static assets like icons.
*   `.vscode/launch.json`: Defines how to launch the debugger (e.g., the "Run Extension" configuration).
*   `src/test/` (if present): Automated test files.

## Contributing

[Optional: Add guidelines for contributing, reporting issues, or submitting pull requests if applicable.]
