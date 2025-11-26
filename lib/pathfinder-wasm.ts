/**
 * WASM Pathfinder Module Loader
 * 
 * Handles loading the WASM module with IndexedDB caching for faster subsequent loads.
 */

import type { InitOutput } from '../pathfinder/pkg/pathfinder';

const DB_NAME = 'pathfinder-wasm-cache';
const DB_VERSION = 1;
const STORE_NAME = 'wasm-modules';
const CACHE_KEY = 'pathfinder-wasm';

// Track initialization state
let wasmModule: InitOutput | null = null;
let initPromise: Promise<InitOutput> | null = null;

/**
 * Open IndexedDB for WASM caching
 */
function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    
    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
  });
}

/**
 * Get cached WASM bytes from IndexedDB
 */
async function getCachedWasm(): Promise<ArrayBuffer | null> {
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(CACHE_KEY);
      
      request.onerror = () => resolve(null);
      request.onsuccess = () => resolve(request.result || null);
    });
  } catch {
    return null;
  }
}

/**
 * Cache WASM bytes in IndexedDB
 */
async function cacheWasm(bytes: ArrayBuffer): Promise<void> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.put(bytes, CACHE_KEY);
      
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  } catch {
    // Caching failed, but that's okay - we can still use the module
  }
}

/**
 * Initialize the WASM module with IndexedDB caching
 * Returns a singleton promise that resolves to the initialized module
 */
export async function initPathfinder(): Promise<InitOutput> {
  // Return existing module if already initialized
  if (wasmModule) {
    return wasmModule;
  }
  
  // Return existing initialization promise if in progress
  if (initPromise) {
    return initPromise;
  }
  
  initPromise = (async () => {
    // Dynamic import of the WASM bindings
    const wasm = await import('../pathfinder/pkg/pathfinder');
    
    // Try to get cached WASM bytes
    const cachedBytes = await getCachedWasm();
    
    if (cachedBytes) {
      // Use cached bytes for faster initialization
      try {
        wasmModule = wasm.initSync({ module: cachedBytes });
        wasm.init();
        return wasmModule;
      } catch {
        // Cache might be corrupted, fall through to fresh load
      }
    }
    
    // Fetch fresh WASM module
    const wasmUrl = new URL('../pathfinder/pkg/pathfinder_bg.wasm', import.meta.url);
    const response = await fetch(wasmUrl);
    const bytes = await response.arrayBuffer();
    
    // Cache for next time
    await cacheWasm(bytes);
    
    // Initialize with fresh bytes
    wasmModule = wasm.initSync({ module: bytes });
    wasm.init();
    
    return wasmModule;
  })();
  
  return initPromise;
}

/**
 * Get the initialized WASM module (throws if not initialized)
 */
export function getPathfinderModule(): InitOutput {
  if (!wasmModule) {
    throw new Error('Pathfinder WASM module not initialized. Call initPathfinder() first.');
  }
  return wasmModule;
}

/**
 * Check if the WASM module is initialized
 */
export function isPathfinderReady(): boolean {
  return wasmModule !== null;
}

// Re-export types
export type { InitOutput } from '../pathfinder/pkg/pathfinder';
