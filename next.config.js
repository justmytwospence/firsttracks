module.exports = {
  reactStrictMode: false,
  webpack: (config, { isServer }) => {
    // Handle WASM modules
    config.experiments = {
      ...config.experiments,
      asyncWebAssembly: true,
      layers: true,
    };
    
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
