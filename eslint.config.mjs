import globals from "globals";

export default [{
    files: ["**/*.js"],
    languageOptions: {
        globals: {
            ...globals.commonjs,
            ...globals.node,
            ...globals.mocha,
            ...globals.browser, // Add standard browser globals (window, document, etc.)
        // Declare VS Code Webview specific globals
        acquireVsCodeApi: "readonly",
        // Declare globals from libraries loaded via <script> tags if any
        marked: "readonly", // Example if marked.js is global
        Prism: "readonly",  // Example if Prism.js is global
        },

        ecmaVersion: 2022,
        sourceType: "module",
    },
    ignores: [
        "node_modules/",
        ".vscode-test/",
        "*.vsix",
        "media/prism.js",    // Optionally ignore vendor libraries if preferred
        "media/tailwind.js" // Optionally ignore vendor libraries if preferred
    ],

    rules: {
        "no-const-assign": "warn",
        "no-this-before-super": "warn",
        "no-undef": "warn",
        "no-unreachable": "warn",
        "no-unused-vars": "warn",
        "constructor-super": "warn",
        "valid-typeof": "warn",
        "no-undef": "error", // Keep this rule active to catch actual undefined variables
    },
}];