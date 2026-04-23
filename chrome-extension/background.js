// =================================================================
// PROXY MANAGEMENT (OPTIONAL)
// =================================================================

/**
 * Sets up an authenticated proxy for all browser requests. This is a two-part process:
 * 1. Use chrome.proxy.settings.set to define the proxy server.
 * 2. Use chrome.webRequest.onAuthRequired to provide credentials when the proxy challenges.
 * @param {object} proxyConfig - An object containing host, port, username, and password.
 */
async function setupProxy(proxyConfig) {
    // Clear any existing proxy settings if config is invalid or empty
    if (!proxyConfig || !proxyConfig.host) {
        chrome.proxy.settings.clear({
            scope: 'regular'
        });
        console.log('Proxy settings cleared.');
        return;
    }

    const config = {
        mode: 'fixed_servers',
        rules: {
            singleProxy: {
                scheme: proxyConfig.scheme || 'http',
                host: proxyConfig.host,
                port: parseInt(proxyConfig.port, 10)
            },
            bypassList: ['<local>'] // Bypass proxy for local network addresses
        }
    };

    // Set the new proxy configuration
    chrome.proxy.settings.set({
        value: config,
        scope: 'regular'
    }, () => {
        console.log(`Proxy set to ${proxyConfig.host}:${proxyConfig.port}`);
    });

    // This listener handles the authentication challenge from the proxy.
    // It must be registered at the top level of the script to be persistent.
    chrome.webRequest.onAuthRequired.addListener(
        (details, callback) => {
            callback({
                authCredentials: {
                    username: proxyConfig.username,
                    password: proxyConfig.password
                }
            });
        }, {
            urls: ['<all_urls>']
        },
        ['blocking']
    );
}

/*
// --- PROXY CONFIGURATION EXAMPLE ---
// To use a proxy, uncomment this block and fill in your proxy details.
// This code will run once when the extension is installed or updated.
chrome.runtime.onInstalled.addListener(() => {
    const myProxy = {
        host: 'your-residential-proxy-provider.com',
        port: 8080,
        username: 'your-proxy-username',
        password: 'your-proxy-password',
        scheme: 'http' // or 'https'
    };
    setupProxy(myProxy);
});
*/

// =================================================================
// SCRIPT INJECTION AND MESSAGE HANDLING
// =================================================================

// Store for managing extraction states
let extractionStates = new Map();

// Listens for messages from other parts of the extension (e.g., popup.js or content.js)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('Background received message:', message.action, 'from:', sender.tab?.id || 'popup');
    
    switch (message.action) {
        case 'initiate_extraction':
            handleExtractionInitiation(message, sender, sendResponse);
            return true; // Keep channel open for async response

        case 'extraction_complete':
            handleExtractionComplete(message, sender);
            break;

        case 'extraction_error':
            handleExtractionError(message, sender);
            break;

        case 'get_extraction_status':
            handleGetExtractionStatus(message, sender, sendResponse);
            return true; // Keep channel open for async response

        case 'get_oauth_token':
            handleOAuthTokenRequest(message, sender, sendResponse);
            return true; // Keep channel open for async response
    }
});

/**
 * Handles extraction initiation from popup
 */
async function handleExtractionInitiation(message, sender, sendResponse) {
    try {
        const tabId = message.tabId;
        if (!tabId) {
            sendResponse({ success: false, error: 'No tab ID provided' });
            return;
        }

        // Store extraction state
        extractionStates.set(tabId, {
            status: 'starting',
            timestamp: Date.now(),
            tabId: tabId
        });

        // Store initial state in Chrome storage for popup to track
        await chrome.storage.local.set({
            [`extraction_${tabId}`]: {
                status: 'starting',
                timestamp: Date.now()
            }
        });

        console.log(`Starting extraction for tab ${tabId}`);

        // Inject the content script
        chrome.scripting.executeScript({
            target: { tabId: tabId },
            files: ['content.js']
        }, (injectionResults) => {
            if (chrome.runtime.lastError || !injectionResults || injectionResults.length === 0) {
                const error = chrome.runtime.lastError?.message || 'No injection result';
                console.error('Script injection failed:', error);
                
                // Update state to error
                extractionStates.set(tabId, {
                    status: 'error',
                    error: 'Failed to inject script into the page',
                    timestamp: Date.now()
                });

                // Store error state
                chrome.storage.local.set({
                    [`extraction_${tabId}`]: {
                        status: 'error',
                        error: 'Failed to inject script into the page',
                        timestamp: Date.now()
                    }
                });

                sendResponse({ success: false, error: 'Failed to inject script into the page' });
            } else {
                console.log('Script injected successfully');
                sendResponse({ success: true });
            }
        });
    } catch (error) {
        console.error('Error in handleExtractionInitiation:', error);
        sendResponse({ success: false, error: error.message });
    }
}

/**
 * Handles extraction completion from content script
 */
async function handleExtractionComplete(message, sender) {
    try {
        const tabId = sender.tab?.id;
        if (!tabId) return;

        console.log(`Extraction completed for tab ${tabId}`, message.data);

        // Update extraction state
        extractionStates.set(tabId, {
            status: 'completed',
            data: message.data,
            timestamp: Date.now()
        });

        // Store result in Chrome storage
        await chrome.storage.local.set({
            [`extraction_${tabId}`]: {
                status: 'completed',
                data: message.data,
                timestamp: Date.now()
            }
        });

        console.log('Extraction results stored successfully');
    } catch (error) {
        console.error('Error handling extraction completion:', error);
    }
}

/**
 * Handles extraction error from content script
 */
async function handleExtractionError(message, sender) {
    try {
        const tabId = sender.tab?.id;
        if (!tabId) return;

        console.log(`Extraction error for tab ${tabId}:`, message.error);

        // Update extraction state
        extractionStates.set(tabId, {
            status: 'error',
            error: message.error,
            timestamp: Date.now()
        });

        // Store error in Chrome storage
        await chrome.storage.local.set({
            [`extraction_${tabId}`]: {
                status: 'error',
                error: message.error,
                timestamp: Date.now()
            }
        });

        console.log('Extraction error stored successfully');
    } catch (error) {
        console.error('Error handling extraction error:', error);
    }
}

/**
 * Handles status check from popup
 */
async function handleGetExtractionStatus(message, sender, sendResponse) {
    try {
        const tabId = message.tabId;
        if (!tabId) {
            sendResponse({ success: false, error: 'No tab ID provided' });
            return;
        }

        // Get status from storage
        const result = await chrome.storage.local.get([`extraction_${tabId}`]);
        const status = result[`extraction_${tabId}`];

        if (status) {
            sendResponse({ success: true, status: status });
        } else {
            sendResponse({ success: false, error: 'No extraction status found' });
        }
    } catch (error) {
        console.error('Error getting extraction status:', error);
        sendResponse({ success: false, error: error.message });
    }
}

/**
 * Handles OAuth2 token requests for Google Sheets integration
 */
async function handleOAuthTokenRequest(message, sender, sendResponse) {
    try {
        console.log('🔑 OAuth2 token requested for scopes:', message.scopes);
        
        // Enhanced OAuth2 implementation with refresh capability
        chrome.identity.getAuthToken({
            interactive: true,
            scopes: message.scopes || ['https://www.googleapis.com/auth/spreadsheets']
        }, (token) => {
            if (chrome.runtime.lastError) {
                console.error('❌ OAuth2 error:', chrome.runtime.lastError);
                sendResponse({
                    success: false,
                    error: chrome.runtime.lastError.message
                });
            } else if (token) {
                console.log('✅ OAuth2 token obtained successfully');
                
                if (message.forceRefresh) {
                    // Invalidate and refresh token if requested
                    chrome.identity.removeCachedAuthToken({ token }, () => {
                        chrome.identity.getAuthToken({
                            interactive: true,
                            scopes: message.scopes || ['https://www.googleapis.com/auth/spreadsheets']
                        }, (newToken) => {
                            if (chrome.runtime.lastError) {
                                sendResponse({
                                    success: false,
                                    error: chrome.runtime.lastError.message
                                });
                            } else {
                                console.log('✅ OAuth2 token refreshed successfully');
                                sendResponse({
                                    success: true,
                                    token: newToken,
                                    refreshed: true
                                });
                            }
                        });
                    });
                } else {
                    sendResponse({
                        success: true,
                        token: token
                    });
                }
            } else {
                console.warn('⚠️ No token received from OAuth2 flow');
                sendResponse({
                    success: false,
                    error: 'No token received from OAuth2 flow'
                });
            }
        });
        
    } catch (error) {
        console.error('❌ OAuth2 token request failed:', error);
        sendResponse({
            success: false,
            error: error.message
        });
    }
}

// Future OAuth2 implementation example:
// async function getOAuth2Token() {
//     return new Promise((resolve, reject) => {
//         chrome.identity.getAuthToken({
//             interactive: true,
//             scopes: ['https://www.googleapis.com/auth/spreadsheets']
//         }, (token) => {
//             if (chrome.runtime.lastError) {
//                 reject(chrome.runtime.lastError);
//             } else {
//                 resolve(token);
//             }
//         });
//     });
// }

// Clean up old extraction states periodically
setInterval(() => {
    const now = Date.now();
    const maxAge = 5 * 60 * 1000; // 5 minutes

    for (const [tabId, state] of extractionStates.entries()) {
        if (now - state.timestamp > maxAge) {
            extractionStates.delete(tabId);
            chrome.storage.local.remove([`extraction_${tabId}`]);
        }
    }
}, 60000); // Check every minute