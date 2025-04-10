# ESLint Configuration Guide (wscode)

This document explains the ESLint setup for the Cerebras Inference VS Code extension (`wscode`) and provides guidance on resolving common linting issues, particularly those related to different execution environments within the extension. The configuration is designed to be platform-agnostic and should work correctly on Linux, Windows, and macOS.

## Overview

ESLint is used in this project to enforce code style consistency and catch potential errors early. The primary configuration file is `eslint.config.mjs` located in the project root.

The project consists of two main types of JavaScript code:

1.  **Extension Backend Code:** Runs in a Node.js environment within VS Code (`extension.js`).
2.  **Webview Frontend Code:** Runs in a browser-like environment within a VS Code webview panel (`media/*.js`).

These different environments have different global variables available (e.g., `require` and `module` in Node.js vs. `document` and `window` in the browser/webview). ESLint needs to be aware of the environment in which a particular file runs to avoid reporting false `no-undef` errors.

## Current Configuration (`eslint.config.mjs`)

The base configuration in `eslint.config.mjs` likely sets up ESLint for the Node.js environment, which is appropriate for `extension.js`. However, this causes `no-undef` warnings for browser/webview-specific globals like `document`, `window`, `acquireVsCodeApi`, `MutationObserver`, etc., when linting files in the `media/` directory.

## Resolving `no-undef` Warnings in `media/` Files

To fix the `no-undef` warnings for the webview code, we need to tell ESLint that files within the `media/` directory run in a browser-like environment and declare any non-standard globals they use (like `acquireVsCodeApi`).

This is achieved using the `overrides` key in the ESLint configuration.

**Steps:**

1.  **Open `eslint.config.mjs`** in your editor.
2.  **Add or modify the `overrides` section** to include a specific configuration for files matching the `media/**/*.js` pattern.

**Example `eslint.config.mjs` Modification:**

```javascript
// eslint.config.mjs
import globals from "globals";
import js from "@eslint/js";

export default [
  // Apply recommended rules to all files
  js.configs.recommended,

  // Base configuration (applies to all JS files unless overridden)
  {
    languageOptions: {
      ecmaVersion: 2022, // Or your target ECMAScript version
      sourceType: "module", // Or "commonjs" if using require/module.exports
      globals: {
        ...globals.node, // Add Node.js globals for backend code
      },
    },
    rules: {
      // Add any project-wide custom rules here
      "no-unused-vars": ["warn", { "argsIgnorePattern": "^_" }], // Example: Warn on unused vars, allow args starting with _
    },
    ignores: [
        "node_modules/",
        ".vscode-test/",
        "*.vsix",
        "media/prism.js",    // Optionally ignore vendor libraries if preferred
        "media/tailwind.js" // Optionally ignore vendor libraries if preferred
    ],
  },

  // --- Add this override section for webview files ---
  {
    files: ["media/**/*.js"], // Target files in the media directory
    languageOptions: {
      globals: {
        ...globals.browser, // Add standard browser globals (window, document, etc.)
        // Declare VS Code Webview specific globals
        acquireVsCodeApi: "readonly",
        // Declare globals from libraries loaded via <script> tags if any
        marked: "readonly", // Example if marked.js is global
        Prism: "readonly",  // Example if Prism.js is global
      },
    },
    rules: {
      // You can add specific rules for frontend code here if needed
      "no-undef": "error", // Keep this rule active to catch actual undefined variables
    },
  },
  // --- End of override section ---

  // You might have other configurations or overrides here
];