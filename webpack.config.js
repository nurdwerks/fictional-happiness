const path = require('path');
const CopyPlugin = require("copy-webpack-plugin");

const extensionConfig = {
  name: 'extension',
  target: 'node', // Extension runs in Node
  mode: 'development',
  entry: './src/extension.ts',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'extension.js',
    libraryTarget: 'commonjs',
  },
  externals: {
    'vscode': 'commonjs vscode',
    // We bundle ws/ot-text/uuid for the extension
  },
  resolve: { extensions: ['.ts', '.js'] },
  module: {
    rules: [{ test: /\.ts$/, exclude: /node_modules/, use: 'ts-loader' }]
  },
  devtool: 'source-map'
};

const webviewConfig = {
  name: 'webview',
  target: 'web', // Webview runs in browser
  mode: 'development',
  entry: './src/webview/webview.ts',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'webview.js',
  },
  resolve: { extensions: ['.ts', '.js'] },
  module: {
    rules: [{ test: /\.ts$/, exclude: /node_modules/, use: 'ts-loader' }]
  },
  devtool: 'source-map',
  plugins: [
      new CopyPlugin({
      patterns: [
        { from: "src/webview/index.html", to: "index.html" },
        { from: "resources", to: "resources", noErrorOnMissing: true } // Copy resources if any
      ],
    }),
  ]
};

module.exports = [extensionConfig, webviewConfig];
