

module.exports = [
  {
    output: {
      path: './dist',
      filename: 'webmuxd.dev.js',
    },
    name: 'development',
    entry: './src/webmuxd',
    mode: 'development',
    devtool: 'source-map'
  },
  {
    output: {
      path: './dist',
      filename: 'webmuxd.js',
    },
    name: 'production',
    entry: './src/webmuxd',
    mode: 'production',
  },
];
