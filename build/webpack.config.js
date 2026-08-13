const path = require('path');

module.exports = {
  mode: 'production',
  entry: './entry.js',
  output: {
    filename: 'jssip.bundle.min.js',
    path: path.resolve(__dirname, '..', 'vendor'),
  },
  resolve: {
    fallback: {
      events: require.resolve('events/'),
    },
  },
};
