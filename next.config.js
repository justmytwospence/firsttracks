module.exports = {
  output: 'export',
  reactStrictMode: true,
  webpack: (config, { isServer }) => {
    // Fix for optional 'encoding' package used by georaster
    config.resolve = {
      ...config.resolve,
      fallback: {
        ...config.resolve?.fallback,
        encoding: false,
      },
    };
    
    // Handle .wasm file loading
    config.module.rules.push({
      test: /\.wasm$/,
      type: 'asset/resource',
    });
    
    if (isServer) {
      config.externals.push('pathfinder');
    }
    return config;
  },
};
