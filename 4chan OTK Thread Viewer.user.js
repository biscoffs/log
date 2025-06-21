// ==UserScript==
// @name         4chan OTK Thread Viewer
// @namespace    http://tampermonkey.net/
// @version      1.3
// @description  Viewer for OTK tracked threads messages with recursive quoted messages and toggle support
// @match        https://boards.4chan.org/b/
// @grant        none
// ==/UserScript==

(function () {
    'use strict';
    console.log('[OTK Viewer EXECUTION] Script starting to execute.');

    let twitterWidgetsLoaded = false;
    let twitterWidgetsLoading = false;
    let embedObserver = null;
    let isFirstRunAfterPageLoad = true;

    let originalBodyOverflow = '';
    let otherBodyNodes = [];
    let isManualViewerRefreshInProgress = false;
    let lastKnownMessageIds = new Set();

    // ---> START OF MOVED BLOCK <---
    const DB_NAME = 'OTKMediaCacheDB';
    const DB_VERSION = 1;
    const STORE_NAME = 'mediaFilesStore';
    let dbPromise = null;

    function openDB() {
        if (dbPromise) {
            return dbPromise; // Return existing promise if already connecting/connected
        }
        dbPromise = new Promise((resolve, reject) => {
            console.log('[OTK Cache] Opening IndexedDB: ' + DB_NAME + ' version ' + DB_VERSION);
            const request = indexedDB.open(DB_NAME, DB_VERSION);

            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                console.log('[OTK Cache] onupgradeneeded: Upgrading/creating database.');
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    const store = db.createObjectStore(STORE_NAME, { keyPath: 'url' });
                    console.log('[OTK Cache] Created object store: ' + STORE_NAME);
                    store.createIndex('timestampIdx', 'timestamp', { unique: false });
                    console.log('[OTK Cache] Created index: timestampIdx');
                }
            };

            request.onsuccess = (event) => {
                console.log('[OTK Cache] Database opened successfully.');
                resolve(event.target.result);
            };

            request.onerror = (event) => {
                console.error('[OTK Cache] Error opening database:', event.target.error);
                dbPromise = null; // Reset promise on error so next call can try again
                reject(event.target.error);
            };

            request.onblocked = (event) => {
                console.warn('[OTK Cache] Database open request blocked. Please close other tabs using this database.', event);
                dbPromise = null; // Reset
                reject(new Error('IndexedDB open request blocked.'));
            };
        });
        return dbPromise;
    }

    async function getMedia(url) {
        try {
            const db = await openDB();
            return new Promise((resolve, reject) => {
                const transaction = db.transaction(STORE_NAME, 'readwrite'); // readwrite to update timestamp
                const store = transaction.objectStore(STORE_NAME);
                const request = store.get(url);

                request.onsuccess = (event) => {
                    const record = event.target.result;
                    if (record) {
                        console.log('[OTK Cache] getMedia: Found record for URL:', url);
                        // Update timestamp for LRU (Least Recently Used)
                        record.timestamp = Date.now();
                        const updateRequest = store.put(record);
                        updateRequest.onerror = (updErr) => {
                            console.error('[OTK Cache] getMedia: Error updating timestamp for URL:', url, updErr.target.error);
                            // Still resolve with the record, timestamp update is best-effort
                            resolve(record.blob);
                        };
                        updateRequest.onsuccess = () => {
                            console.log('[OTK Cache] getMedia: Timestamp updated for URL:', url);
                            resolve(record.blob);
                        };
                    } else {
                        console.log('[OTK Cache] getMedia: No record found for URL:', url);
                        resolve(null);
                    }
                };
                request.onerror = (event) => {
                    console.error('[OTK Cache] getMedia: Error getting record for URL:', url, event.target.error);
                    reject(event.target.error);
                };
                transaction.oncomplete = () => {
                    // console.log('[OTK Cache] getMedia: Transaction completed for URL:', url);
                };
                transaction.onerror = (event) => {
                    console.error('[OTK Cache] getMedia: Transaction error for URL:', url, event.target.error);
                    reject(event.target.error); // This might reject before request.onerror if transaction itself fails
                };
            });
        } catch (dbOpenError) {
            console.error('[OTK Cache] getMedia: Failed to open DB, cannot get media for URL:', url, dbOpenError);
            return null; // Or reject(dbOpenError)
        }
    }

    async function saveMedia(url, blob, filename = '', originalExt = '') {
        try {
            const db = await openDB();
            return new Promise((resolve, reject) => {
                if (!blob || blob.size === 0) {
                    console.warn('[OTK Cache] saveMedia: Blob is null or empty for URL:', url, '. Skipping save.');
                    return reject(new Error('Cannot save null or empty blob.'));
                }

                const transaction = db.transaction(STORE_NAME, 'readwrite');
                const store = transaction.objectStore(STORE_NAME);
                const mediaType = blob.type.startsWith('image/') ? 'image' : (blob.type.startsWith('video/') ? 'video' : 'other');

                const record = {
                    url: url,
                    blob: blob,
                    timestamp: Date.now(),
                    filename: filename,
                    originalExt: originalExt,
                    mediaType: mediaType,
                    size: blob.size
                };

                const request = store.put(record);

                request.onsuccess = () => {
                    console.log('[OTK Cache] saveMedia: Successfully saved/updated media for URL:', url, '(Size: ' + blob.size + ')');
                    resolve(true);
                };
                request.onerror = (event) => {
                    console.error('[OTK Cache] saveMedia: Error saving media for URL:', url, event.target.error);
                    if (event.target.error.name === 'QuotaExceededError') {
                        console.warn('[OTK Cache] QuotaExceededError! Need to implement cache eviction.');
                        // TODO: Implement cache eviction strategy here or trigger it.
                    }
                    reject(event.target.error);
                };
                 transaction.oncomplete = () => {
                    // console.log('[OTK Cache] saveMedia: Transaction completed for URL:', url);
                };
                transaction.onerror = (event) => {
                    console.error('[OTK Cache] saveMedia: Transaction error for URL:', url, event.target.error);
                    reject(event.target.error);
                };
            });
        } catch (dbOpenError) {
            console.error('[OTK Cache] saveMedia: Failed to open DB, cannot save media for URL:', url, dbOpenError);
            return false; // Or reject(dbOpenError)
        }
    }
    // ---> END OF MOVED BLOCK <---

    // Storage keys (must match tracker script)
    const THREADS_KEY = 'otkActiveThreads';
    const MESSAGES_KEY = 'otkMessagesByThreadId';
    const COLORS_KEY = 'otkThreadColors';
    const SELECTED_MESSAGE_KEY = 'otkSelectedMessageId';
    // const PAGE_REFRESH_ANCHOR_STATE_KEY = 'otkPageRefreshAnchorState'; // Commented out for debugging
    // const ANCHORED_MESSAGE_LINE_RATIO = 0.0; // Commented out for debugging

    // Decode HTML entities utility
    function decodeEntities(encodedString) {
        const txt = document.createElement('textarea');
        txt.innerHTML = encodedString;
        return txt.value;
    }

    function showLoadingOverlay(message) {
        if (loadingOverlay) { // loadingOverlay is the DOM element
            loadingOverlay.textContent = message;
            loadingOverlay.style.setProperty('display', 'flex', 'important');
            loadingOverlay.style.opacity = '1';
            // Updated log to include the actual textContent property for verification
            console.log(`[OTK Loading] Overlay SHOWN with message: "${message}" (textContent: "${loadingOverlay.textContent}")`);
            void loadingOverlay.offsetHeight; // Force reflow
        } else {
            console.error("[OTK Loading] loadingOverlay element not found in showLoadingOverlay!");
        }
    }

    function hideLoadingOverlay() {
        if (loadingOverlay) {
            loadingOverlay.style.display = 'none';
            console.log('[OTK Loading] Overlay HIDDEN.');
        }
    }

    function handleIntersection(entries, observer) {
        entries.forEach(entry => {
            const placeholder = entry.target;
            const isLoaded = placeholder.dataset.loaded === 'true';

            if (entry.isIntersecting) {
                if (!isLoaded) {
                    // Load iframe or direct video
                    const embedType = placeholder.dataset.embedType;
                    const videoId = placeholder.dataset.videoId;
                    const startTime = placeholder.dataset.startTime; // Will be undefined if not set

                    console.log(`[OTK Viewer IO] Loading embed for: ${embedType} - ${videoId}`);

                    if (embedType === 'streamable') {
                        const guessedMp4Url = `https://cf-files.streamable.com/temp/${videoId}.mp4`;
                        placeholder.innerHTML = '<div class="play-button-overlay" style="color: #ccc;">▶ Checking cache...</div>'; // Temporary loading indicator
                        placeholder.style.backgroundColor = '#2c2c2c'; // Ensure loading bg

                        getMedia(guessedMp4Url).then(cachedBlob => {
                            if (cachedBlob) {
                                const objectURL = URL.createObjectURL(cachedBlob);
                                const frameId = placeholder.closest('[id^="otk-frame-"]') ? placeholder.closest('[id^="otk-frame-"]').id : 'io_placeholder_context';
                                placeholder.innerHTML = createVideoElementHTML(objectURL, videoId, 'streamable', frameId);
                                placeholder.dataset.loaded = 'true';
                                placeholder.dataset.cached = 'true';
                                console.log(`[OTK Cache IO] Loaded Streamable ${videoId} from cache.`);
                                placeholder.style.height = 'auto';
                                placeholder.style.aspectRatio = '16 / 9'; // Keep aspect ratio for video
                                placeholder.style.backgroundColor = 'transparent'; // Clear loading bg
                            } else {
                                placeholder.innerHTML = '<div class="play-button-overlay" style="color: #ccc;">▶ Fetching video...</div>'; // Update loading indicator
                                fetch(guessedMp4Url)
                                    .then(response => {
                                        if (response.ok && response.headers.get('content-type')?.startsWith('video/')) {
                                            return response.blob();
                                        }
                                        throw new Error('Streamable direct MP4 fetch failed or not a video. Status: ' + response.status + ' URL: ' + guessedMp4Url);
                                    })
                                    .then(blob => {
                                        saveMedia(guessedMp4Url, blob, videoId + '.mp4', '.mp4');
                                        const objectURL = URL.createObjectURL(blob);
                                        const frameId = placeholder.closest('[id^="otk-frame-"]') ? placeholder.closest('[id^="otk-frame-"]').id : 'io_placeholder_context';
                                        placeholder.innerHTML = createVideoElementHTML(objectURL, videoId, 'streamable', frameId);
                                        placeholder.dataset.loaded = 'true';
                                        placeholder.dataset.cached = 'true'; // Mark as cached even if fetched now
                                        console.log(`[OTK Cache IO] Fetched, cached, and loaded Streamable ${videoId}.`);
                                        placeholder.style.height = 'auto';
                                        placeholder.style.aspectRatio = '16 / 9'; // Keep aspect ratio
                                        placeholder.style.backgroundColor = 'transparent';
                                    })
                                    .catch(err => {
                                        console.warn(`[OTK Cache IO] Streamable direct MP4 for ${videoId} failed: ${err.message}. Falling back to iframe.`);
                                        placeholder.innerHTML = getStreamableIframeHTML(videoId); // Fallback
                                        placeholder.dataset.loaded = 'true';
                                        placeholder.style.height = '360px'; // Fallback fixed height for iframe
                                        placeholder.style.aspectRatio = '';
                                        placeholder.style.backgroundColor = 'transparent'; // Clear loading bg
                                    });
                            }
                        }).catch(dbError => {
                            console.error(`[OTK Cache IO] IndexedDB error for Streamable ${videoId}: ${dbError.message}. Falling back to iframe.`);
                            placeholder.innerHTML = getStreamableIframeHTML(videoId); // Fallback
                            placeholder.dataset.loaded = 'true';
                            placeholder.style.height = '360px'; // Fallback fixed height
                            placeholder.style.aspectRatio = '';
                            placeholder.style.backgroundColor = 'transparent'; // Clear loading bg
                        });
                    } else if (embedType === 'youtube') {
                        const iframeHTML = getYouTubeIframeHTML(videoId, startTime ? parseInt(startTime, 10) : null);
                        placeholder.style.height = '';
                        placeholder.style.aspectRatio = '16 / 9';
                        // console.log(`[OTK Viewer IO] Ensured placeholder aspect-ratio 16/9 for ${embedType}: ${videoId}`);
                         if (iframeHTML) {
                            placeholder.innerHTML = iframeHTML;
                            placeholder.dataset.loaded = 'true';
                        }
                    } else if (embedType === 'twitch-clip' || embedType === 'twitch-vod') {
                        const iframeHTML = getTwitchIframeHTML(embedType === 'twitch-clip' ? 'clip' : 'video', videoId, startTime ? parseInt(startTime, 10) : null);
                        placeholder.style.height = '360px'; // Twitch iframes often need this
                        placeholder.style.aspectRatio = '';
                        // console.log(`[OTK Viewer IO] Set placeholder height to 360px for ${embedType}: ${videoId}`);
                         if (iframeHTML) {
                            placeholder.innerHTML = iframeHTML;
                            placeholder.dataset.loaded = 'true';
                        }
                    }
                    // The original common `if (iframeHTML)` block is removed as logic is now per-case.
                }
            } else {
                // Unload iframe (element is out of view)
                if (isLoaded) {
                    console.log(`[OTK Viewer IO] Unloading embed for: ${placeholder.dataset.embedType} - ${placeholder.dataset.videoId}`);
                    const embedType = placeholder.dataset.embedType;
                    const videoId = placeholder.dataset.videoId;
                    let innerPlaceholderHTML = '<div class="play-button-overlay">▶</div>';
                    let specificClass = '';
                    let specificText = '';

                    // Restore visual cues for specific services
                    if (embedType === 'youtube') {
                        placeholder.style.backgroundImage = `url('https://i.ytimg.com/vi/${videoId}/mqdefault.jpg')`;
                        specificClass = 'youtube-placeholder';
                    } else if (embedType === 'twitch-clip' || embedType === 'twitch-vod') {
                        placeholder.style.backgroundImage = ''; // Clear any previous
                        specificClass = 'twitch-placeholder';
                        specificText = embedType === 'twitch-clip' ? 'Twitch Clip' : 'Twitch VOD';
                        innerPlaceholderHTML += `<span style="position:absolute; bottom:5px; font-size:10px; color:rgba(255,255,255,0.7);">${specificText}</span>`;
                    } else if (embedType === 'streamable') {
                        placeholder.style.backgroundImage = '';
                        specificClass = 'streamable-placeholder';
                        specificText = 'Streamable Video';
                        innerPlaceholderHTML += `<span style="position:absolute; bottom:5px; font-size:10px; color:rgba(255,255,255,0.7);">${specificText}</span>`;
                    }

                    // ---> ADD NEW LOGIC BELOW <---
                    placeholder.style.height = ''; // Reset fixed height
                    placeholder.style.aspectRatio = '16 / 9'; // Reset to default CSS aspect ratio
                    console.log(`[OTK Viewer IO] Reset placeholder style for ${embedType}: ${videoId} before unloading.`);
                    // ---> ADD NEW LOGIC ABOVE <---

                    placeholder.innerHTML = innerPlaceholderHTML; // Existing line
                    placeholder.dataset.loaded = 'false'; // Existing line
                    // Ensure correct placeholder class is there if it got removed (it shouldn't if we only change innerHTML)
                    if (specificClass && !placeholder.classList.contains(specificClass)) {
                        placeholder.classList.add(specificClass);
                    }
                }
            }
        });
    }

    function handlePlaceholderInteraction(event) {
        // Find the placeholder element, whether event target is placeholder or its child (like the play button text span)
        const placeholder = event.target.closest('.embed-placeholder');

        if (!placeholder || placeholder.dataset.loaded === 'true') {
            return; // Not a placeholder or already loaded
        }

        // Check for correct event type and key for keydown
        if (event.type === 'click' || (event.type === 'keydown' && (event.key === 'Enter' || event.key === ' '))) {
            if (event.type === 'keydown') {
                event.preventDefault(); // Prevent space from scrolling, enter from submitting form etc.
            }

            // Same loading logic as in IntersectionObserver's intersecting branch
            const embedType = placeholder.dataset.embedType;
            const videoId = placeholder.dataset.videoId;
            const startTime = placeholder.dataset.startTime;
            // let iframeHTML = ''; // iframeHTML will be handled per-case now
            console.log('[OTK Viewer UX] handlePlaceholderInteraction: Processing event for embedType: ' + embedType + ', videoId: ' + videoId + ', eventType: ' + event.type);
            console.log(`[OTK Viewer UX] Manually triggering load for: ${embedType} - ${videoId}`);

            if (embedType === 'streamable') {
                const guessedMp4Url = `https://cf-files.streamable.com/temp/${videoId}.mp4`;
                placeholder.innerHTML = '<div class="play-button-overlay" style="color: #ccc;">▶ Checking cache...</div>'; // Temp loading indicator
                placeholder.style.backgroundColor = '#2c2c2c'; // Ensure loading bg

                getMedia(guessedMp4Url).then(cachedBlob => {
                    if (cachedBlob) {
                        const objectURL = URL.createObjectURL(cachedBlob);
                        const frameId = placeholder.closest('[id^="otk-frame-"]') ? placeholder.closest('[id^="otk-frame-"]').id : 'interaction_placeholder_context';
                        placeholder.innerHTML = createVideoElementHTML(objectURL, videoId, 'streamable', frameId);
                        placeholder.dataset.loaded = 'true';
                        placeholder.dataset.cached = 'true';
                        console.log(`[OTK Cache UX] Loaded Streamable ${videoId} from cache.`);
                        placeholder.style.height = 'auto';
                        placeholder.style.aspectRatio = '16 / 9'; // Keep aspect ratio
                        placeholder.style.backgroundColor = 'transparent'; // Clear loading bg
                    } else {
                        placeholder.innerHTML = '<div class="play-button-overlay" style="color: #ccc;">▶ Fetching video...</div>';
                        fetch(guessedMp4Url)
                            .then(response => {
                                if (response.ok && response.headers.get('content-type')?.startsWith('video/')) {
                                    return response.blob();
                                }
                                throw new Error('Streamable direct MP4 fetch failed or not a video. Status: ' + response.status + ' URL: ' + guessedMp4Url);
                            })
                            .then(blob => {
                                saveMedia(guessedMp4Url, blob, videoId + '.mp4', '.mp4');
                                const objectURL = URL.createObjectURL(blob);
                                const frameId = placeholder.closest('[id^="otk-frame-"]') ? placeholder.closest('[id^="otk-frame-"]').id : 'interaction_placeholder_context';
                                placeholder.innerHTML = createVideoElementHTML(objectURL, videoId, 'streamable', frameId);
                                placeholder.dataset.loaded = 'true';
                                placeholder.dataset.cached = 'true'; // Mark as cached even if fetched now
                                console.log(`[OTK Cache UX] Fetched, cached, and loaded Streamable ${videoId}.`);
                                placeholder.style.height = 'auto';
                                placeholder.style.aspectRatio = '16 / 9'; // Keep aspect ratio
                                placeholder.style.backgroundColor = 'transparent';
                            })
                            .catch(err => {
                                console.warn(`[OTK Cache UX] Streamable direct MP4 for ${videoId} failed: ${err.message}. Falling back to iframe.`);
                                placeholder.innerHTML = getStreamableIframeHTML(videoId); // Fallback
                                placeholder.dataset.loaded = 'true';
                                placeholder.style.height = '360px'; // Fallback fixed height
                                placeholder.style.aspectRatio = '';
                                placeholder.style.backgroundColor = 'transparent';
                            });
                    }
                }).catch(dbError => {
                    console.error(`[OTK Cache UX] IndexedDB error for Streamable ${videoId}: ${dbError.message}. Falling back to iframe.`);
                    placeholder.innerHTML = getStreamableIframeHTML(videoId); // Fallback
                    placeholder.dataset.loaded = 'true';
                    placeholder.style.height = '360px'; // Fallback fixed height
                    placeholder.style.aspectRatio = '';
                    placeholder.style.backgroundColor = 'transparent';
                });
                event.stopPropagation(); // Stop propagation for Streamable as it's handled
                // console.log('[OTK Viewer UX] Stopped event propagation after manual load attempt for ' + embedType + ': ' + videoId);
            } else if (embedType === 'youtube') {
                const iframeHTML = getYouTubeIframeHTML(videoId, startTime ? parseInt(startTime, 10) : null);
                placeholder.style.height = '';
                placeholder.style.aspectRatio = '16 / 9';
                // console.log(`[OTK Viewer UX] Ensured placeholder aspect-ratio 16/9 for manually loaded ${embedType}: ${videoId}`);
                if (iframeHTML) {
                    placeholder.innerHTML = iframeHTML;
                    placeholder.dataset.loaded = 'true';
                    event.stopPropagation();
                    // console.log('[OTK Viewer UX] Stopped event propagation after manual load for ' + embedType + ': ' + videoId);
                }
            } else if (embedType === 'twitch-clip' || embedType === 'twitch-vod') {
                const iframeHTML = getTwitchIframeHTML(embedType === 'twitch-clip' ? 'clip' : 'video', videoId, startTime ? parseInt(startTime, 10) : null);
                placeholder.style.height = '360px'; // Twitch iframes often need this
                placeholder.style.aspectRatio = '';
                // console.log(`[OTK Viewer UX] Set placeholder height to 360px for manually loaded ${embedType}: ${videoId}`);
                if (iframeHTML) {
                    placeholder.innerHTML = iframeHTML;
                    placeholder.dataset.loaded = 'true';
                    event.stopPropagation();
                    // console.log('[OTK Viewer UX] Stopped event propagation after manual load for ' + embedType + ': ' + videoId);
                }
            }
            // The original common `if (iframeHTML)` block is removed as logic is now per-case.
        }
    }

    function ensureTwitterWidgetsLoaded() {
        console.log('[OTK Tweet DEBUG - ensureTwitterWidgetsLoaded] Called.'); // Added
        return new Promise((resolve, reject) => {
            if (twitterWidgetsLoaded && window.twttr && typeof window.twttr.widgets === 'object' && typeof window.twttr.widgets.createTweet === 'function') {
                console.log('[OTK Tweet DEBUG - ensureTwitterWidgetsLoaded] Widgets already loaded and function exists. Resolving.'); // Added
                resolve();
                return;
            }
            // If already loading, set up a poller
            if (twitterWidgetsLoading) {
                console.log('[OTK Tweet DEBUG - ensureTwitterWidgetsLoaded] Widgets currently loading by another call. Starting poller.'); // Added
                let attempts = 0;
                const interval = setInterval(() => {
                    attempts++;
                    if (twitterWidgetsLoaded && window.twttr && typeof window.twttr.widgets === 'object' && typeof window.twttr.widgets.createTweet === 'function') {
                        clearInterval(interval);
                        console.log('[OTK Tweet DEBUG - ensureTwitterWidgetsLoaded] Poller success: Widgets loaded.'); // Added
                        resolve();
                    } else if (attempts > 60) { // Timeout after ~6 seconds (60 * 100ms)
                        clearInterval(interval);
                        console.error('[OTK Tweet DEBUG - ensureTwitterWidgetsLoaded] Poller TIMEOUT waiting for Twitter widgets.'); // Added
                        reject(new Error('Timeout waiting for Twitter widgets.js to load after initiation.'));
                    }
                }, 100);
                return; // The promise is already being handled by the first call that set twitterWidgetsLoading = true.
            }

            twitterWidgetsLoading = true;
            console.log('[OTK Tweet DEBUG - ensureTwitterWidgetsLoaded] Creating script element for widgets.js.'); // Added
            const script = document.createElement('script');
            script.id = 'twitter-widgets-script';
            script.src = 'https://platform.twitter.com/widgets.js';
            script.async = true;
            script.charset = 'utf-8';
            script.onload = () => {
                console.log('[OTK Tweet DEBUG - ensureTwitterWidgetsLoaded] widgets.js script.onload fired.'); // Added
                twitterWidgetsLoaded = true;
                twitterWidgetsLoading = false;
                if (window.twttr && typeof window.twttr.widgets === 'object' && typeof window.twttr.widgets.createTweet === 'function') {
                    console.log('[OTK Tweet DEBUG - ensureTwitterWidgetsLoaded] twttr.widgets.createTweet found in onload. Resolving after short delay.'); // Added
                    // Add a small delay for widgets.js to fully initialize after script load event
                    setTimeout(resolve, 100);
                } else {
                     console.warn('[OTK Tweet DEBUG - ensureTwitterWidgetsLoaded] widgets.js loaded but createTweet not immediately found in onload. Relying on 500ms safety check or other polls.'); // Added
                    // The polling mechanism for 'twitterWidgetsLoading' should catch it if it initializes shortly after.
                    // console.warn('Twitter widgets.js loaded but twttr.widgets.createTweet not immediately found. Will rely on polling if initiated by another call.'); // Original log
                    // To be safe, reject if it's not found after a brief moment.
                    setTimeout(() => {
                        if (window.twttr && typeof window.twttr.widgets === 'object' && typeof window.twttr.widgets.createTweet === 'function') {
                            console.log('[OTK Tweet DEBUG - ensureTwitterWidgetsLoaded] createTweet found in 500ms safety check.'); // Added
                            resolve();
                        } else {
                            console.error('[OTK Tweet DEBUG - ensureTwitterWidgetsLoaded] createTweet NOT found even after 500ms safety check in onload. Rejecting.'); // Added
                            reject(new Error('Twitter widgets.js loaded but twttr.widgets.createTweet not found after delay.'));
                        }
                    }, 500);
                }
            };
            script.onerror = () => {
                console.error('[OTK Tweet DEBUG - ensureTwitterWidgetsLoaded] FAILED to load Twitter widgets.js script (onerror).'); // Added
                twitterWidgetsLoading = false;
                reject(new Error('Failed to load Twitter widgets.js script.'));
            };
            document.head.appendChild(script);
        });
    }

    // MODIFIED FUNCTION (createTweetWithTimeout)
    function createTweetWithTimeout(tweetId, placeholderElement, options, timeoutMs = 40000) {
        const originalUrl = placeholderElement.dataset.originalUrl || `https://twitter.com/unknown/status/${tweetId}`;
        // console.log(`[OTK TweetDebug] createTweetWithTimeout: ENTER - Tweet ID: ${tweetId}, Placeholder ID: ${placeholderElement.id}, URL: ${originalUrl}, Timeout: ${timeoutMs}ms`); // This log is already present from previous subtask (turn 135/136)
        
        return new Promise((resolve, reject) => {
            let timeoutHandle = setTimeout(() => {
                const timeoutMessage = `Tweet ${tweetId} loading timed out.`;
                placeholderElement.textContent = timeoutMessage;
                placeholderElement.style.color = 'orange';
                console.warn(`[OTK TweetDebug] createTweetWithTimeout: Set placeholder ${placeholderElement.id} text to '${timeoutMessage}'. (Timeout for Tweet ID ${tweetId} after ${timeoutMs}ms)`);
                placeholderElement.dataset.tweetGloballyProcessed = 'true'; 
                reject({ tweetId: tweetId, status: 'rejected', reason: 'Timeout', placeholderId: placeholderElement.id, originalUrl: originalUrl });
            }, timeoutMs);

            window.twttr.widgets.createTweet(tweetId, placeholderElement, options)
                .then(tweetElement => { 
                    clearTimeout(timeoutHandle);
                    if (tweetElement) { 
                        // console.log(`[OTK TweetDebug] createTweetWithTimeout: SUCCESS - Tweet ID: ${tweetId}, Placeholder ID: ${placeholderElement.id}. Replacing placeholder content.`); // Already present
                        placeholderElement.innerHTML = ''; 
                        placeholderElement.appendChild(tweetElement);
                        placeholderElement.dataset.tweetGloballyProcessed = 'true'; 
                        resolve({ tweetId: tweetId, status: 'fulfilled', placeholderId: placeholderElement.id, originalUrl: originalUrl, element: tweetElement });
                    } else { 
                        // console.warn(`[OTK TweetDebug] createTweetWithTimeout: SUCCESS (but no element) - Tweet ID: ${tweetId}, Placeholder ID: ${placeholderElement.id}. Tweet might be deleted or unavailable.`); // Already present
                        placeholderElement.textContent = `Tweet ${tweetId} unavailable (possibly deleted).`; 
                        placeholderElement.style.color = '#aaa'; 
                        placeholderElement.dataset.tweetGloballyProcessed = 'true'; 
                        resolve({ tweetId: tweetId, status: 'fulfilled_empty', placeholderId: placeholderElement.id, originalUrl: originalUrl }); 
                    }
                })
                .catch(error => { 
                    clearTimeout(timeoutHandle);
                    const apiErrorMessage = `Failed to load tweet ${tweetId} (API error).`;
                    placeholderElement.textContent = apiErrorMessage; 
                    placeholderElement.style.color = 'red';
                    // console.error(`[OTK TweetDebug] createTweetWithTimeout: FAILED (API error) - Tweet ID: ${tweetId}, Placeholder ID: ${placeholderElement.id}. Error:`, error); // Log from previous subtask
                    console.error(`[OTK TweetDebug] createTweetWithTimeout: Set placeholder ${placeholderElement.id} text to '${apiErrorMessage}'. Error:`, error); // More specific log for text update
                    placeholderElement.dataset.tweetGloballyProcessed = 'true'; 
                    reject({ tweetId: tweetId, status: 'rejected', reason: 'API error', error: error, placeholderId: placeholderElement.id, originalUrl: originalUrl });
                });
        });
    }

    // MODIFIED FUNCTION (processTweetEmbeds)
    async function processTweetEmbeds(containerElement) {
        console.log('[OTK Viewer Tweets DEBUG] processTweetEmbeds: Called. Container querySelectorAll for .twitter-embed-placeholder found:', containerElement.querySelectorAll('.twitter-embed-placeholder').length, 'placeholders.');
        const placeholders = Array.from(containerElement.querySelectorAll('.twitter-embed-placeholder'));
        // Assuming processedTweetIds is a global Set, declare if not:
        // if (typeof processedTweetIds === 'undefined') { processedTweetIds = new Set(); } 
        // For now, this log will rely on it being declared elsewhere or will error if not.
        // The primary mechanism for global skip is placeholder.dataset.tweetGloballyProcessed.
        
        if (placeholders.length === 0) {
            return;
        }

        const uniqueTweetIdsInThisBatch = new Set(); // Renamed from processedInThisRun
        // console.log('[OTK Viewer Tweets DEBUG] processTweetEmbeds: Initializing. Globally processed IDs so far (from a global Set, if used):', Array.from(processedTweetIds || []), 'Placeholders to process in this specific batch call:', placeholders.length);
        // The above log might be problematic if processedTweetIds isn't truly global/initialized.
        // Focusing on what's available:
        const globallyProcessedPlaceholders = Array.from(containerElement.querySelectorAll('.twitter-embed-placeholder[data-tweet-globally-processed="true"]'));
        console.log('[OTK Viewer Tweets DEBUG] processTweetEmbeds: Initializing. Count of placeholders already marked data-tweet-globally-processed="true":', globallyProcessedPlaceholders.length, '. Placeholders to potentially process in this batch call:', placeholders.length);


        try {
            console.log('[OTK Viewer Tweets DEBUG] processTweetEmbeds: Attempting to ensure Twitter widgets are loaded (this call is inside processTweetEmbeds)...');
            await ensureTwitterWidgetsLoaded(); 
            console.log('[OTK Viewer Tweets DEBUG] processTweetEmbeds: Twitter widgets loading ensured (promise resolved). Proceeding with placeholder processing.');
            const tweetPromises = [];

            // console.log('[OTK Viewer Tweets] Starting loop to create tweet processing promises for ' + placeholders.length + ' placeholders...'); // Original log
            placeholders.forEach(placeholder => { // Changed from for...of to forEach for easier logging access if needed before var declarations
                const tweetId = placeholder.dataset.tweetId;
                const originalUrl = placeholder.dataset.originalUrl; // Ensure this is present
                // data-otk-tweet-queued is not used anymore, so logging it might be confusing or show undefined.
                console.log(`[OTK Viewer Tweets DEBUG] processTweetEmbeds: Iterating placeholder. ID: ${placeholder.id}, Tweet ID: ${tweetId}, Original URL: ${originalUrl}, data-tweet-globally-processed: ${placeholder.dataset.tweetGloballyProcessed}`);

                if (placeholder.dataset.tweetGloballyProcessed === 'true') {
                    console.log(`[OTK Viewer Tweets DEBUG] processTweetEmbeds: SKIPPING (globally processed - data-tweet-globally-processed="true") - Placeholder ID: ${placeholder.id}, Tweet ID: ${tweetId}`);
                    return; // continue in forEach is 'return'
                }

                if (!tweetId) {
                    placeholder.textContent = 'Invalid tweet data (no ID).'; // Update placeholder
                    placeholder.style.color = 'darkred';
                    placeholder.dataset.tweetGloballyProcessed = 'true'; 
                    console.warn('[OTK Viewer Tweets DEBUG] processTweetEmbeds: SKIPPING placeholder - No Tweet ID found. Placeholder ID:', placeholder.id, 'Original HTML snippet:', placeholder.innerHTML.substring(0,100));
                    return;
                }

                if (uniqueTweetIdsInThisBatch.has(tweetId)) {
                    console.log(`[OTK Viewer Tweets DEBUG] processTweetEmbeds: SKIPPING (already added to promises in this batch run via uniqueTweetIdsInThisBatch) - Placeholder ID: ${placeholder.id}, Tweet ID: ${tweetId}`);
                    // Ensure even skipped-for-batch placeholders (if not globally processed) show "Loading..."
                    if (!placeholder.innerHTML.includes('Loading Tweet...')) {
                         placeholder.innerHTML = 'Loading Tweet...';
                         placeholder.style.display = 'flex';
                         placeholder.style.alignItems = 'center';
                         placeholder.style.justifyContent = 'center';
                    }
                    return;
                }
                
                uniqueTweetIdsInThisBatch.add(tweetId); 

                console.log(`[OTK Viewer Tweets DEBUG] processTweetEmbeds: QUEUING for processing (adding to tweetPromises) - Placeholder ID: ${placeholder.id}, Tweet ID: ${tweetId}`);
                placeholder.innerHTML = 'Loading Tweet...'; 
                placeholder.style.display = 'flex';
                placeholder.style.alignItems = 'center';
                placeholder.style.justifyContent = 'center';

                tweetPromises.push(
                    createTweetWithTimeout(tweetId, placeholder, {
                        theme: 'light',
                        conversation: 'none',
                        align: 'center',
                        width: 500,
                        dnt: true
                    }, 40000) // Use 40s timeout
                    // .then and .catch are now handled inside createTweetWithTimeout for structured resolve/reject
                    // The placeholder.dataset.tweetGloballyProcessed is also set inside createTweetWithTimeout
                );
            });

            console.log('[OTK Viewer Tweets DEBUG] processTweetEmbeds: Finished creating all tweet processing promises. Total unique tweets queued in this batch: ' + uniqueTweetIdsInThisBatch.size + '. Now awaiting Promise.allSettled for ' + tweetPromises.length + ' promises.');
            const results = await Promise.allSettled(tweetPromises);
            console.log('[OTK Viewer Tweets DEBUG] processTweetEmbeds: All tweetPromises settled. Results count:', results.length);
            results.forEach((result, index) => {
                const outcome = result.status === 'fulfilled' ? result.value : result.reason;
                // Check if outcome has the properties we expect (it should, due to changes in createTweetWithTimeout)
                if (outcome && outcome.tweetId && outcome.placeholderId) {
                     console.log(`[OTK Viewer Tweets DEBUG] processTweetEmbeds: Promise for Tweet ID ${outcome.tweetId} (Placeholder: ${outcome.placeholderId}, URL: ${outcome.originalUrl || 'N/A'}) settled. Status: ${result.status}. Full outcome:`, outcome);
                } else {
                     console.log(`[OTK Viewer Tweets DEBUG] processTweetEmbeds: Promise ${index} settled. Status: ${result.status}. Value/Reason (unexpected structure):`, outcome);
                }
            });
            // console.log('[OTK Viewer LIFECYCLE] processTweetEmbeds: All createTweet promises have settled.'); // More detailed log above now

        } catch (loadError) {
            console.error("Failed to load Twitter widgets or process embeds:", loadError);
            placeholders.forEach(placeholder => {
                // Ensure it's a placeholder that might have been cleared or attempted
                if (placeholder.classList.contains('twitter-embed-placeholder')) {
                    const tweetId = placeholder.dataset.tweetId;
                    const originalEscapedUrl = placeholder.dataset.originalUrl;
                    let displayText = `View Tweet (ID: ${tweetId})`;

                    if (originalEscapedUrl) {
                        const urlMatch = originalEscapedUrl.match(/twitter\.com\/([a-zA-Z0-9_]+)\/status/);
                        if (urlMatch && urlMatch[1]) {
                            displayText = `View Tweet by @${urlMatch[1]} (ID: ${tweetId})`;
                        }
                        placeholder.innerHTML = `<a href="${originalEscapedUrl}" target="_blank" rel="noopener noreferrer" style="color: #1da1f2; text-decoration: none;">${displayText} 🐦 (Embed blocked by client/network)</a>`;
                    } else {
                        const fallbackUrl = `https://twitter.com/anyuser/status/${tweetId}`; // Should ideally not happen
                        placeholder.innerHTML = `<a href="${fallbackUrl}" target="_blank" rel="noopener noreferrer" style="color: #1da1f2; text-decoration: none;">${displayText} 🐦 (Embed blocked, original URL missing)</a>`;
                    }
                    // Reset styling from 'Loading...' state
                    placeholder.style.display = 'block';
                    placeholder.style.alignItems = '';
                    placeholder.style.justifyContent = '';
                }
            });
        }
    }

    // Helper function to create YouTube embed HTML
    function getYouTubeIframeHTML(videoId, startTimeSeconds) {
        let finalSrc = `https://www.youtube.com/embed/${videoId}`;
        if (startTimeSeconds && startTimeSeconds > 0) {
            finalSrc += `?start=${startTimeSeconds}`;
        }
        const iframeHtml = `<iframe width="560" height="315" src="${finalSrc}" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen style="aspect-ratio: 16 / 9; width: 100%; max-width: 560px;"></iframe>`;
        return `<div style="display: block; margin-top: 5px; margin-bottom: 5px;">${iframeHtml}</div>`;
    }

    function createTwitterEmbedPlaceholder(tweetId, originalUrl) {
        const placeholderId = `tweet-embed-placeholder-${tweetId}-${Math.random().toString(36).substring(2, 9)}`;
        let displayText = `View Tweet (ID: ${tweetId})`;
        const urlMatch = originalUrl.match(/twitter\.com\/([a-zA-Z0-9_]+)\/status/);
        if (urlMatch && urlMatch[1]) {
            displayText = `View Tweet by @${urlMatch[1]} (ID: ${tweetId})`;
        }
        const escapedUrl = originalUrl.replace(/"/g, '&quot;');

        // This div will be targeted by twttr.widgets.createTweet
        // It contains a fallback link in case embedding fails or JS is disabled.
        const generatedHtml = `<div class="twitter-embed-placeholder" data-tweet-id="${tweetId}" id="${placeholderId}" data-original-url="${escapedUrl}" style="border: 1px solid #ddd; padding: 10px 15px; min-height: 100px; background-color: #f9f9f9; border-radius: 5px; margin: 5px 0;">` +
                           `<a href="${escapedUrl}" target="_blank" rel="noopener noreferrer" style="color: #1da1f2; text-decoration: none;">${displayText} 🐦 (Loading Tweet...)</a>` +
                           `</div>`;
        console.log(`[OTK Placeholder Gen - Twitter] For Tweet ID ${tweetId}, Raw HTML: ${generatedHtml.substring(0, 300)}...`);
        return generatedHtml;
    }

    // Helper function to create Rumble link HTML (updated from embed)
    function createRumbleEmbed(rumbleIdWithV, originalUrl) {
        let displayText;
        // Try to get a more descriptive title from the path part of the URL
        const urlPathMatch = originalUrl.match(/rumble\.com\/(?:v[a-zA-Z0-9]+-)?([a-zA-Z0-9_-]+)(?:\.html|$|\?)/);
        if (urlPathMatch && urlPathMatch[1] && urlPathMatch[1].toLowerCase() !== 'embed') {
            // Capitalize first letter and replace hyphens/underscores with spaces
            let titleCandidate = urlPathMatch[1].replace(/[-_]/g, ' ');
            titleCandidate = titleCandidate.charAt(0).toUpperCase() + titleCandidate.slice(1);
            displayText = `View on Rumble: ${titleCandidate}`;
        } else {
            // Fallback display text if path parsing doesn't yield a good title
            displayText = `View on Rumble (Clip ID: ${rumbleIdWithV})`;
        }
        const escapedUrl = originalUrl.replace(/"/g, '&quot;');
        return `<a href="${escapedUrl}" target="_blank" rel="noopener noreferrer" style="display: block; padding: 10px; border: 1px solid #ccc; border-radius: 10px; text-decoration: none; color: #85c742; background-color: #f0f0f0;">${displayText} <img src="https://rumble.com/favicon.ico" style="width:16px; height:16px; vertical-align:middle; border:none;"></a>`;
    }

    // Helper function to format seconds to Twitch's hms time format
    function formatSecondsToTwitchTime(totalSeconds) {
        if (totalSeconds === null || totalSeconds === undefined || totalSeconds <= 0) {
            return null;
        }
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = Math.floor(totalSeconds % 60); // Ensure seconds is integer
        return `${String(hours).padStart(2, '0')}h${String(minutes).padStart(2, '0')}m${String(seconds).padStart(2, '0')}s`;
    }

    // Helper function to create Twitch embed HTML
    function getTwitchIframeHTML(type, id, startTimeSeconds) { // Added startTimeSeconds
        const parentHostname = 'boards.4chan.org';
        let src = '';
        if (type === 'clip') {
            src = `https://clips.twitch.tv/embed?clip=${id}&parent=${parentHostname}&autoplay=false`;
        } else if (type === 'video') {
            src = `https://player.twitch.tv/?video=${id}&parent=${parentHostname}&autoplay=false`;
            const formattedTime = formatSecondsToTwitchTime(startTimeSeconds);
            if (formattedTime) {
                src += `&t=${formattedTime}`;
            }
        }
        const iframeHtml = `<iframe src="${src}" style="width: 100%; min-height: 360px; aspect-ratio: 16 / 9; max-width: 640px; border: none;" allowfullscreen scrolling="no"></iframe>`;
        return `<div style="display: block; margin-top: 5px; margin-bottom: 5px;">${iframeHtml}</div>`;
    }

    // Helper function to create Streamable embed HTML
    function getStreamableIframeHTML(videoId) {
        const iframeHtml = `<iframe src="https://streamable.com/e/${videoId}?loop=false" style="width: 100%; min-height: 360px; aspect-ratio: 16 / 9; max-width: 640px; border: none;" allowfullscreen></iframe>`;
        return `<div style="display: block; margin-top: 5px; margin-bottom: 5px;">${iframeHtml}</div>`;
    }

function createVideoElementHTML(blobUrl, videoId, type, parentFrameId) { // Added parentFrameId
    const loopAttribute = (type === 'streamable') ? 'loop="false"' : ''; // Add loop="false" for streamable
    // Using String(blobUrl) in case blobUrl is not a string, and substring(0,80) to keep log concise
    console.log('[OTK Video Debug] createVideoElementHTML called for videoId:', videoId, 'type:', type, 'in frame:', (parentFrameId || 'unknown_placeholder_frame'), 'BlobURL:', String(blobUrl).substring(0, 80));
    // console.log(`[OTK Cache] Creating direct video element for ${type} ID ${videoId} with blob URL.`); // Original log replaced
    return `<video src="${blobUrl}" controls autoplay="false" ${loopAttribute} style="width: 100%; min-height: 360px; aspect-ratio: 16 / 9; max-width: 640px; border: none; margin: 8px 0; display: block; background-color: #000;"></video>`;
}

    // Helper functions for YouTube time parsing
    function parseTimeParam(timeString) {
        if (!timeString) return null;
        let totalSeconds = 0;
        if (/^\d+$/.test(timeString)) {
            totalSeconds = parseInt(timeString, 10);
        } else {
            const hoursMatch = timeString.match(/(\d+)h/);
            if (hoursMatch) totalSeconds += parseInt(hoursMatch[1], 10) * 3600;
            const minutesMatch = timeString.match(/(\d+)m/);
            if (minutesMatch) totalSeconds += parseInt(minutesMatch[1], 10) * 60;
            const secondsMatch = timeString.match(/(\d+)s/);
            if (secondsMatch) totalSeconds += parseInt(secondsMatch[1], 10);
        }
        return totalSeconds > 0 ? totalSeconds : null;
    }

    function getTimeFromParams(allParamsString) {
        if (!allParamsString) return null;
        // Matches t=VALUE or start=VALUE from the param string
        const timeMatch = allParamsString.match(/[?&](?:t|start)=([^&]+)/);
        if (timeMatch && timeMatch[1]) {
            return parseTimeParam(timeMatch[1]);
        }
        return null;
    }

   function debounce(func, delay) {
       let timeout;
       return function(...args) {
           const context = this;
           clearTimeout(timeout);
           timeout = setTimeout(() => func.apply(context, args), delay);
       };
   }

   async function scrollToMessageById(messageId, blockAlign = 'center', isExplicitSelection = false) {
       const MAX_RETRIES = 5; // Max number of attempts to find the element
       const RETRY_DELAY_MS = 750; // Delay between retry attempts

       for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
           const element = viewer.querySelector('div[data-message-id="' + messageId + '"]');
           if (element) {
               if (isExplicitSelection) {
                   const previouslySelected = viewer.querySelector('.selected-message');
                   if (previouslySelected && previouslySelected !== element) { // Avoid removing class from element itself if re-selecting
                       previouslySelected.classList.remove('selected-message');
                   }
                   element.classList.add('selected-message');
               }
               console.log('[OTK Viewer Scroll] scrollToMessageById: Found element for ID ' + messageId + ' on attempt ' + attempt + '. Will scroll with align: ' + blockAlign + '.');

               // The actual scroll is still delayed slightly after finding
               setTimeout(() => {
                   console.log('[OTK Viewer Scroll] scrollToMessageById: Scrolling to element for ID ' + messageId + ' after action delay.');
                   element.scrollIntoView({ behavior: 'auto', block: blockAlign });
               }, 250); // Keep this short delay for the scroll action itself
               return true; // Element found, scroll initiated (or will be shortly)
           } else {
               console.log('[OTK Viewer Scroll] scrollToMessageById: Element NOT FOUND for ID ' + messageId + ' on attempt ' + attempt + '/' + MAX_RETRIES + '.');
               if (attempt < MAX_RETRIES) {
                   console.log('[OTK Viewer Scroll] Retrying find for ID ' + messageId + ' in ' + RETRY_DELAY_MS + 'ms...');
                   await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
               }
           }
       }

    // This log line below was the original final log before 'return false'
    // console.log(`[OTK Viewer Scroll] scrollToMessageById: Element NOT FOUND for ID \${messageId} after all \${MAX_RETRIES} attempts.`);
    // We'll make it part of the new diagnostic block for clarity.

    // New diagnostic block:
    console.log('[OTK Viewer Diagnostics] scrollToMessageById: FINAL FAILURE to find ID ' + messageId + ' after ' + MAX_RETRIES + ' attempts.');
    if (viewer) { // Check if viewer itself exists
        console.log('    - viewer.isConnected: ' + viewer.isConnected);
        console.log('    - viewer.children.length (direct children): ' + viewer.children.length);
        const currentMessagesInDOM = viewer.querySelectorAll('div[data-message-id]');
        console.log('    - found elements with data-message-id: ' + currentMessagesInDOM.length);

        if (currentMessagesInDOM.length === 0 && viewer.children.length > 0) {
            // If no data-message-id divs found but viewer has children, log snippet
            console.log('    - viewer.innerHTML snippet (start): ' + viewer.innerHTML.substring(0, 2000));
            console.log('    - viewer.innerHTML snippet (end): ' + viewer.innerHTML.substring(Math.max(0, viewer.innerHTML.length - 2000)));
        } else if (currentMessagesInDOM.length > 0 && currentMessagesInDOM.length < 15) {
            // If some messages are found but not many, log their IDs
            let ids = [];
            currentMessagesInDOM.forEach(el => ids.push(el.dataset.messageId));
            console.log('    - IDs found in DOM: [' + ids.join(', ') + ']');
            // Check if the target ID is among them but perhaps under a different query
            if (!ids.includes(messageId)) {
                 console.log('    - Target ID ' + messageId + ' is NOT among these found IDs.');
            }
        } else if (currentMessagesInDOM.length === 0 && viewer.children.length === 0) {
            console.log('    - viewer appears to be completely empty.');
        }
    } else {
        console.log('    - CRITICAL: viewer element itself is null or undefined at this point!');
    }

       return false; // Element not found after all retries
   }

   function getTopMostVisibleMessageInfo(viewerElement) {
    if (!viewerElement || viewerElement.style.display === 'none' || !viewerElement.children.length) {
        return null;
    }
    const viewerRectTop = viewerElement.getBoundingClientRect().top;
    const messages = viewerElement.querySelectorAll('div[data-message-id]');
    for (let i = 0; i < messages.length; i++) {
        const msgElement = messages[i];
        const msgElementRect = msgElement.getBoundingClientRect();
        if (msgElementRect.bottom > viewerRectTop && msgElementRect.top < viewerElement.getBoundingClientRect().bottom) { //Ensure it's actually in viewport
            return {
                messageId: msgElement.dataset.messageId,
                scrollTop: viewerElement.scrollTop // Current scroll position of the viewer
            };
        }
    }
    // Fallback if no message is strictly at the top but viewer is scrolled
    if (messages.length > 0 && viewerElement.scrollTop > 0) {
        // Find message closest to current scrollTop - more complex, for now, above is primary
    }
    return null; // Or return first message if any other heuristic fails
   }

function captureLineAnchoredScrollState() {
    /* Entire body commented for debugging */
    return null;
}

async function restoreLineAnchoredScrollState(state) {
    /* Entire body commented for debugging */
    return false;
}

async function manageInitialScroll() {
    // isFirstRunAfterPageLoad logic can be removed if not strictly needed by other parts,
    // or kept if it serves a purpose beyond scroll. For this refactor, let's assume it's not essential for scroll.
    if (isFirstRunAfterPageLoad) { // Keep isFirstRunAfterPageLoad for now as it might be used elsewhere or for future logic
        console.log('[OTK Viewer LIFECYCLE] manageInitialScroll: First run after page load. Flag will be cleared.');
        isFirstRunAfterPageLoad = false; // Clear the flag
    }
    console.log('[OTK Scroll] manageInitialScroll: Entered');
    let scrollRestored = false;

    // 1. Try Line Anchored Scroll Restoration (for F5 refresh)
    // const savedStateJSON = localStorage.getItem(PAGE_REFRESH_ANCHOR_STATE_KEY); 
    // if (savedStateJSON) {
    //     console.log('[OTK Scroll Lines] Found saved anchor state for F5 refresh:', savedStateJSON);
    //     try {
    //         const savedState = JSON.parse(savedStateJSON);
    //         if (savedState) {
    //             console.log('[OTK Scroll Lines] Attempting to restore F5 scroll using line anchored state:', savedState);
    //             if (await restoreLineAnchoredScrollState(savedState)) { 
    //                 scrollRestored = true;
    //                 console.log('[OTK Scroll Lines] Successfully restored F5 scroll using line anchored state.');
    //             } else {
    //                 console.warn('[OTK Scroll Lines] Failed to restore F5 scroll using line anchored state.');
    //             }
    //         }
    //     } catch (e) {
    //         console.error('[OTK Scroll Lines] Error parsing saved anchor state JSON:', e);
    //     }
    //     localStorage.removeItem(PAGE_REFRESH_ANCHOR_STATE_KEY); 
    // }

    // 2. Try Explicit Selection (SELECTED_MESSAGE_KEY from localStorage) if F5 anchor restore didn't happen or failed
    if (!scrollRestored) {
        const explicitSelectionId = localStorage.getItem(SELECTED_MESSAGE_KEY);
        if (explicitSelectionId) {
            console.log('[OTK Viewer Scroll] manageInitialScroll: Attempting to restore explicit selection:', explicitSelectionId);
            if (await scrollToMessageById(explicitSelectionId, 'center', true)) { // true for isExplicitSelection
                // hideLoadingOverlay(); // hideLoadingOverlay is currently a no-op
                // viewer.style.display = 'block'; // This logic is now at the end
                console.log('[OTK Viewer] Explicit selection restored.'); // Simpler log for now
                scrollRestored = true; // Mark as restored
                // Explicit selection will also fall through to the final hide/show logic
            } else {
                 console.log('[OTK Scroll] Explicit selection restore failed: message not found.');
            }
        }
    }

    // 3. Fallback: Scroll to Newest Message (if no other scroll method worked)
    if (!scrollRestored) { // This condition is key: only if F5 anchor failed AND explicit selection was not found/failed.
        console.log('[OTK Viewer Scroll] manageInitialScroll: No specific scroll target found or restored by anchor/selection, scrolling to newest message.');
        if (viewer.children.length > 0) {
        const lastMessageElement = viewer.lastElementChild;
        if (lastMessageElement && typeof lastMessageElement.scrollIntoView === 'function') {
            // Adding a small delay as was present in some earlier versions, helps ensure layout before scroll
            await new Promise(resolve => setTimeout(resolve, 50)); 
            lastMessageElement.scrollIntoView({ behavior: 'auto', block: 'end' });
            console.log('[OTK Viewer Scroll] Scrolled to last message (fallback).');
        }
    }
    }

    // 4. Final action: Ensure viewer is visible and then hide loading overlay.
    if (viewer) { // Ensure viewer exists before trying to show it
        viewer.style.display = 'block'; 
        console.log('[OTK Viewer] Main viewer display set to block after loading and scroll in manageInitialScroll.');
    } else {
        console.error('[OTK Viewer] CRITICAL: Viewer element not found at end of manageInitialScroll when trying to make it visible!');
    }
    
    showLoadingOverlay("Finalizing view and scroll position..."); // Restored
    // console.log('[OTK Loading] All scroll and content processing complete in manageInitialScroll. Adding SIGNIFICANT delay before hiding overlay.'); // Original log for this section
    await new Promise(r => setTimeout(r, 1000)); // INCREASED DELAY
            
    // This should be the VERY LAST action.
    // if (loadingOverlay) loadingOverlay.style.display = 'none';  // Removed direct manipulation
    console.log('[OTK Viewer LIFECYCLE] manageInitialScroll: Processing complete, overlay hidden.');
    if (loadingOverlay) loadingOverlay.style.display = 'none';
}

    async function renderImageFromPlaceholder(placeholderElement, attachmentData, parentFrameId, renderedFullSizeImagesSet) {
        const { tim, ext, filename, w: fullW, h: fullH, tn_w, tn_h, board = 'b' } = attachmentData;
        const baseImageUrl = 'https://i.4cdn.org/' + board + '/';
        const isFullSizeDisplayed = renderedFullSizeImagesSet.has(tim);

        const img = document.createElement('img');
        img.style.maxWidth = '100%'; // Ensure responsiveness
        img.style.height = 'auto';
        img.style.cursor = 'pointer';
        img.alt = decodeURIComponent(filename) + ext;
        img.title = `Click to toggle size: ${decodeURIComponent(filename)}${ext}`;

        const imgWrapper = document.createElement('div');
        imgWrapper.style.display = 'inline-block'; // To allow text flow around it if needed, or use 'block'
        imgWrapper.style.margin = '5px';
        imgWrapper.appendChild(img);

        let currentSrcUrl;
        let objectUrlToRevoke = null;

        const displayFullSize = async () => {
            currentSrcUrl = baseImageUrl + tim + ext;
            img.style.maxWidth = fullW + 'px';
            img.style.maxHeight = fullH + 'px';
            placeholderElement.dataset.mode = 'full';
            renderedFullSizeImagesSet.add(tim);
            console.log(`[OTK Media Replace - ${parentFrameId}] Displaying FULL image for ${tim}${ext}`);

            try {
                const cachedBlob = await getMedia(currentSrcUrl);
                if (cachedBlob) {
                    objectUrlToRevoke = URL.createObjectURL(cachedBlob);
                    img.src = objectUrlToRevoke;
                    console.log(`[OTK Cache - ${parentFrameId}] Loaded FULL image ${tim}${ext} from cache.`);
                } else {
                    img.src = currentSrcUrl; // Set src to actual URL to trigger browser fetch
                    console.log(`[OTK Cache - ${parentFrameId}] FULL image ${tim}${ext} not in cache, fetching from network.`);
                    // Asynchronously fetch and cache
                    fetch(currentSrcUrl)
                        .then(response => {
                            if (!response.ok) throw new Error(`Network response was not ok for ${currentSrcUrl}: ${response.statusText}`);
                            return response.blob();
                        })
                        .then(blob => {
                            saveMedia(currentSrcUrl, blob, decodeURIComponent(filename) + ext, ext);
                            console.log(`[OTK Cache - ${parentFrameId}] Fetched and cached FULL image ${tim}${ext}.`);
                            // No need to set img.src again if browser is already loading it from network src
                        })
                        .catch(fetchErr => {
                            console.error(`[OTK Cache - ${parentFrameId}] Error fetching/caching FULL image ${tim}${ext}:`, fetchErr);
                            img.alt = `Error loading full image: ${decodeURIComponent(filename)}${ext}`;
                            if (placeholderElement.parentNode) placeholderElement.textContent = '[Error loading full image]';
                        });
                }
            } catch (e) {
                console.error(`[OTK Media Replace - ${parentFrameId}] Error in displayFullSize for ${tim}${ext}:`, e);
                img.src = currentSrcUrl; // Fallback to network if cache read fails
            }
        };

        const displayThumbnail = async () => {
            currentSrcUrl = baseImageUrl + tim + 's.jpg'; // Thumbnails are always .jpg
            img.style.maxWidth = tn_w + 'px';
            img.style.maxHeight = tn_h + 'px';
            placeholderElement.dataset.mode = 'thumb';
            renderedFullSizeImagesSet.delete(tim);
            console.log(`[OTK Media Replace - ${parentFrameId}] Displaying THUMB image for ${tim}${ext}`);

            try {
                const cachedBlob = await getMedia(currentSrcUrl);
                if (cachedBlob) {
                    objectUrlToRevoke = URL.createObjectURL(cachedBlob);
                    img.src = objectUrlToRevoke;
                    console.log(`[OTK Cache - ${parentFrameId}] Loaded THUMB image ${tim}s.jpg from cache.`);
                } else {
                    img.src = currentSrcUrl;
                    console.log(`[OTK Cache - ${parentFrameId}] THUMB image ${tim}s.jpg not in cache, fetching from network.`);
                     fetch(currentSrcUrl)
                        .then(response => {
                            if (!response.ok) throw new Error(`Network response was not ok for ${currentSrcUrl}: ${response.statusText}`);
                            return response.blob();
                        })
                        .then(blob => {
                            saveMedia(currentSrcUrl, blob, decodeURIComponent(filename) + 's.jpg', '.jpg');
                            console.log(`[OTK Cache - ${parentFrameId}] Fetched and cached THUMB image ${tim}s.jpg.`);
                        })
                        .catch(fetchErr => {
                            console.error(`[OTK Cache - ${parentFrameId}] Error fetching/caching THUMB image ${tim}s.jpg:`, fetchErr);
                            img.alt = `Error loading thumbnail: ${decodeURIComponent(filename)}${ext}`;
                            if (placeholderElement.parentNode) placeholderElement.textContent = '[Error loading thumbnail]';
                        });
                }
            } catch (e) {
                console.error(`[OTK Media Replace - ${parentFrameId}] Error in displayThumbnail for ${tim}${ext}:`, e);
                img.src = currentSrcUrl; // Fallback to network
            }
        };

        img.onload = () => {
            if (objectUrlToRevoke) {
                URL.revokeObjectURL(objectUrlToRevoke);
                objectUrlToRevoke = null;
            }
            console.log(`[OTK Media Replace - ${parentFrameId}] Image loaded: ${img.src.substring(0,100)}`);
        };
        img.onerror = () => {
            console.error(`[OTK Media Replace - ${parentFrameId}] Error loading image: ${currentSrcUrl}`);
            imgWrapper.innerHTML = `[Error loading image: ${currentSrcUrl.substring(currentSrcUrl.lastIndexOf('/')+1)}]`;
        };

        imgWrapper.addEventListener('click', (e) => {
            e.preventDefault();
            if (placeholderElement.dataset.mode === 'thumb') {
                displayFullSize();
            } else {
                displayThumbnail();
            }
        });

        if (isFullSizeDisplayed) {
            await displayFullSize();
        } else {
            await displayThumbnail();
        }

        if (placeholderElement.parentNode) {
            placeholderElement.parentNode.replaceChild(imgWrapper, placeholderElement);
            console.log(`[OTK Media Replace - ${parentFrameId}] Replaced IMAGE placeholder for ${tim}${ext}`);
        } else {
            console.warn(`[OTK Media Replace - ${parentFrameId}] Placeholder for ${tim}${ext} has no parent, cannot replace.`);
        }
    }

    async function renderVideoFromPlaceholder(placeholderElement, attachmentData, parentFrameId) {
        const { tim, ext, filename, w, h, board = 'b' } = attachmentData;
        const videoUrl = 'https://i.4cdn.org/' + board + '/' + tim + ext;

        const videoElement = document.createElement('video');
        videoElement.controls = true;
        videoElement.loop = false;
        videoElement.preload = 'metadata'; // Recommended for saving bandwidth
        videoElement.style.maxWidth = w + 'px';
        videoElement.style.maxHeight = h + 'px';
        videoElement.style.width = '100%'; // Responsive within its max dimensions
        videoElement.style.backgroundColor = '#000';
        videoElement.poster = placeholderElement.dataset.thumbUrl || ''; // Optional: if thumb URL was stored on placeholder

        let objectUrlToRevoke = null;

        videoElement.onloadeddata = () => {
            console.log(`[OTK Media Replace - ${parentFrameId}] Video data loaded for ${tim}${ext} (src: ${videoElement.src.substring(0,100)})`);
            if (objectUrlToRevoke) {
                 // It's generally safer to revoke when the video is no longer needed or page is unloaded,
                 // but for simplicity in this context, revoking once data starts loading might be okay for some browsers.
                 // However, the video might need to seek or re-buffer. Consider when to best revoke.
                 // For now, let's not revoke immediately on loadeddata.
                 // URL.revokeObjectURL(objectUrlToRevoke); objectUrlToRevoke = null;
            }
        };
        videoElement.onerror = (e) => {
            console.error(`[OTK Media Replace - ${parentFrameId}] Error loading video ${tim}${ext} (src: ${videoElement.src.substring(0,100)}):`, e);
            if (placeholderElement.parentNode) { // Check if placeholder is still there (it should be if video failed to load)
                 const errorMsgDiv = document.createElement('div');
                 errorMsgDiv.textContent = `[Error loading video: ${filename}${ext}]`;
                 errorMsgDiv.style.color = 'red';
                 placeholderElement.parentNode.replaceChild(errorMsgDiv, placeholderElement);
            }
        };
        videoElement.onstalled = () => console.warn(`[OTK Media Replace - ${parentFrameId}] Video stalled for ${tim}${ext}`);
        videoElement.onsuspend = () => console.warn(`[OTK Media Replace - ${parentFrameId}] Video suspended for ${tim}${ext}`);
        
        try {
            const cachedBlob = await getMedia(videoUrl);
            if (cachedBlob) {
                objectUrlToRevoke = URL.createObjectURL(cachedBlob);
                videoElement.src = objectUrlToRevoke;
                console.log(`[OTK Cache - ${parentFrameId}] Loaded VIDEO ${tim}${ext} from cache.`);
            } else {
                videoElement.src = videoUrl;
                console.log(`[OTK Cache - ${parentFrameId}] VIDEO ${tim}${ext} not in cache, fetching from network.`);
                // Asynchronously fetch and cache
                fetch(videoUrl)
                    .then(response => {
                        if (!response.ok) throw new Error(`Network response was not ok for ${videoUrl}: ${response.statusText}`);
                        return response.blob();
                    })
                    .then(blob => {
                        saveMedia(videoUrl, blob, decodeURIComponent(filename) + ext, ext);
                        console.log(`[OTK Cache - ${parentFrameId}] Fetched and cached VIDEO ${tim}${ext}.`);
                    })
                    .catch(fetchErr => {
                        console.error(`[OTK Cache - ${parentFrameId}] Error fetching/caching VIDEO ${tim}${ext}:`, fetchErr);
                        // The videoElement.onerror should handle displaying an error to the user.
                    });
            }
        } catch (e) {
            console.error(`[OTK Media Replace - ${parentFrameId}] Error in renderVideoFromPlaceholder for ${tim}${ext}:`, e);
            videoElement.src = videoUrl; // Fallback to network if cache read fails
        }

        videoElement.load(); // Call load to start loading the media

        if (placeholderElement.parentNode) {
            placeholderElement.parentNode.replaceChild(videoElement, placeholderElement);
            console.log(`[OTK Media Replace - ${parentFrameId}] Replaced VIDEO placeholder for ${tim}${ext}`);
        } else {
             console.warn(`[OTK Media Replace - ${parentFrameId}] Placeholder for ${tim}${ext} has no parent, cannot replace.`);
        }
    }

    async function processMediaPlaceholdersAsync(contentElement, msg, parentFrameId, renderedFullSizeImages) { // msg is messageObject
        const placeholders = Array.from(contentElement.querySelectorAll('div.media-placeholder'));
        if (placeholders.length > 0) {
            console.log(`[OTK Media Replace - ${parentFrameId}] Starting to process ${placeholders.length} media placeholders for message ${msg.id}.`);
        }
        for (const placeholder of placeholders) {
            if (!placeholder.parentNode) {
                 console.log(`[OTK Media Replace - ${parentFrameId}] Placeholder for ${placeholder.dataset.tim} already processed or removed, skipping.`);
                 continue; 
            }
            const mediaType = placeholder.dataset.mediaType;
            const attachmentData = msg.attachment; 

            if (!attachmentData || placeholder.dataset.tim !== String(attachmentData.tim)) { 
                console.warn(`[OTK Media Replace - ${parentFrameId}] Attachment data mismatch or missing for placeholder:`, placeholder.dataset, msg.attachment);
                placeholder.textContent = '[Error: Media data mismatch]';
                continue;
            }

            console.log(`[OTK Media Replace - ${parentFrameId}] Processing placeholder for ${attachmentData.tim}${attachmentData.ext}, type: ${mediaType}`);
            try {
                if (mediaType === 'image') {
                    await renderImageFromPlaceholder(placeholder, attachmentData, parentFrameId, renderedFullSizeImages);
                } else if (mediaType === 'video') {
                    await renderVideoFromPlaceholder(placeholder, attachmentData, parentFrameId);
                }
            } catch (e) {
                console.error(`[OTK Media Replace - ${parentFrameId}] Error processing placeholder for ${attachmentData.tim}:`, e, placeholder);
                if (placeholder.parentNode) placeholder.textContent = `[Error loading media]`;
            }
        }
    }


    async function renderMessageWithQuotes(msg, threadId, depth = 0, ancestors = [], embedCounts, renderedFullSizeImages, parentFrameId) { // Added parentFrameId
        if (ancestors.includes(msg.id)) {
            // Detected a circular quote, stop rendering this branch.
            // Return a comment node or an empty document fragment.
            const comment = document.createComment(`Skipping circular quote to post ${msg.id}`);
            return comment;
        }
        const color = threadColors[threadId] || '#888';

        // Create container div for quoted messages (recursively)
        const container = document.createElement('div');
        // container.style.marginLeft = `${depth * 20}px`; // Removed to align all messages
        if (depth === 0) {
            container.style.backgroundColor = '#fff';
            container.dataset.messageId = msg.id; // Set data-message-id for top-level messages

            // Add click event listener for selection
            container.addEventListener('click', function(event) {
                const currentSelectedId = localStorage.getItem(SELECTED_MESSAGE_KEY);
                const thisMessageId = String(msg.id); // Ensure string comparison

                // Deselect if clicking the already selected message
                if (currentSelectedId === thisMessageId) {
                    localStorage.removeItem(SELECTED_MESSAGE_KEY);
                    this.classList.remove('selected-message');
                } else {
                    // Remove highlight from previously selected message
                    const previouslySelected = viewer.querySelector('.selected-message');
                    if (previouslySelected) {
                        previouslySelected.classList.remove('selected-message');
                    }

                    // Store new selected message ID and highlight it
                    localStorage.setItem(SELECTED_MESSAGE_KEY, thisMessageId);
                    // sessionStorage.removeItem('otkLastScrolledMessageId'); // Removed for new scroll logic
                    console.log('[OTK Viewer Scroll] Cleared lastScrolledMessageId due to explicit selection.'); // Log can remain or be updated
                    this.classList.add('selected-message');
                }
                event.stopPropagation(); // Stop event from bubbling
            });

        } else {
            // Alternating backgrounds for quoted messages
            container.style.backgroundColor = (depth % 2 === 1) ? 'rgba(0,0,0,0.05)' : '#fff';
        }
        container.style.borderRadius = '4px';
        container.style.padding = '6px 8px';
        container.style.marginBottom = '8px';

        if (depth === 0) {
            container.style.borderBottom = '1px solid #ccc';
            // Optionally, adjust padding or margin if the border makes spacing awkward
            // For example, increase bottom padding or change margin:
            container.style.paddingBottom = '10px'; // Increase padding to give content space from border
            container.style.marginBottom = '15px'; // Increase margin to space out from next main message
        }

        // Find quotes in this message text
        const quoteIds = [];
        const quoteRegex = /&gt;&gt;(\d+)/g;
        let m;
        while ((m = quoteRegex.exec(msg.text)) !== null) {
            quoteIds.push(m[1]);
        }

        // Render quoted messages recursively (above)
        for (const qid of quoteIds) {
            const found = findMessage(qid);
            if (found) {
                const quotedEl = await renderMessageWithQuotes(found.msg, found.threadId, depth + 1, [...ancestors, msg.id], embedCounts, renderedFullSizeImages, parentFrameId); // Added await
                container.appendChild(quotedEl);
            }
        }

        // Create main message div
        const postDiv = document.createElement('div');
        postDiv.style.display = 'flex';
        postDiv.style.alignItems = 'flex-start';

        if (depth === 0) {
            // Color square
            const colorSquare = document.createElement('div');
            colorSquare.style.cssText = `
                width: 15px;
                height: 40px;
                background-color: ${color};
                border-radius: 3px;
                margin-right: 10px;
                flex-shrink: 0;
            `;
            postDiv.appendChild(colorSquare);
        }

        const textWrapperDiv = document.createElement('div');
        textWrapperDiv.style.display = 'flex';
        textWrapperDiv.style.flexDirection = 'column';

        // Post number and timestamp container
        const headerDiv = document.createElement('div');
        headerDiv.style.cssText = 'margin-right: 10px; font-size: 12px; color: #555; flex-shrink: 0; white-space: nowrap;';
        const dt = new Date(msg.time * 1000);
        headerDiv.textContent = `#${msg.id} ${dt.toLocaleString()}`;
        textWrapperDiv.appendChild(headerDiv);

        // Content
        const contentDiv = document.createElement('div');
        contentDiv.classList.add('post-content');
        contentDiv.style.whiteSpace = 'pre-wrap';
        contentDiv.innerHTML = convertQuotes(msg.text, embedCounts); // This sets initial HTML including placeholders
        console.log(`[OTK RenderMsg - ${msg.id}] contentDiv.innerHTML after convertQuotes: ${contentDiv.innerHTML.substring(0, 500)}...`);
        textWrapperDiv.appendChild(contentDiv);

        // ------ NEW ATTACHMENT HANDLING ------
        if (msg.attachment && msg.attachment.tim) {
            const attach = msg.attachment;
            const board = 'b'; // Assuming 'b' for now
            const attachExt = attach.ext.toLowerCase();

            if (['.jpg', '.jpeg', '.png', '.gif'].includes(attachExt)) {
                const imgPlaceholderString = `<div class="media-placeholder" data-media-type="image" data-board="${board}" data-tim="${attach.tim}" data-ext="${attach.ext}" data-filename="${encodeURIComponent(attach.filename || '')}" data-width="${attach.w}" data-height="${attach.h}" data-thumb-width="${attach.tn_w}" data-thumb-height="${attach.tn_h}">[Loading Image: ${attach.filename || 'image'}${attach.ext}]</div>`;
                contentDiv.innerHTML += imgPlaceholderString; // Append placeholder string
                console.log(`[OTK RenderMsg - ${msg.id}] contentDiv.innerHTML after adding 4chan media placeholder: ${contentDiv.innerHTML.substring(0, 500)}...`);
                console.log(`[OTK Placeholder Generation] In renderMessageWithQuotes: Added IMAGE placeholder string for ${attach.tim}${attach.ext} to message ${msg.id}`);
            } else if (['.webm', '.mp4'].includes(attachExt)) {
                const vidPlaceholderString = `<div class="media-placeholder" data-media-type="video" data-board="${board}" data-tim="${attach.tim}" data-ext="${attach.ext}" data-filename="${encodeURIComponent(attach.filename || '')}" data-width="${attach.w}" data-height="${attach.h}">[Loading Video: ${attach.filename || 'video'}${attach.ext}]</div>`;
                contentDiv.innerHTML += vidPlaceholderString; // Append placeholder string
                console.log(`[OTK RenderMsg - ${msg.id}] contentDiv.innerHTML after adding 4chan media placeholder: ${contentDiv.innerHTML.substring(0, 500)}...`);
                console.log(`[OTK Placeholder Generation] In renderMessageWithQuotes: Added VIDEO placeholder string for ${attach.tim}${attach.ext} to message ${msg.id}`);
            }
        }
        // After all innerHTML is set (including placeholders from above block)
        await processMediaPlaceholdersAsync(contentDiv, msg, parentFrameId, renderedFullSizeImages);
        // ------ END OF NEW ATTACHMENT HANDLING ------
        postDiv.appendChild(textWrapperDiv);

        container.appendChild(postDiv);
        console.log(`[OTK RenderMsg - ${msg.id}] Final container.innerHTML to be returned (first 800 chars): ${container.innerHTML.substring(0, 800)}...`);
        return container;
    }

    // Render all messages chronologically across all threads
    async function renderAllMessages() { // Ensure it's async (already was)
        console.log('[OTK Video Debug - renderAllMessages] ENTER. isManualViewerRefreshInProgress:', isManualViewerRefreshInProgress); // Added
        await new Promise(r => setTimeout(r, 50)); // Increased delay
        console.log('[OTK Viewer LIFECYCLE] renderAllMessages: Entered after increased delay.');
        const renderedFullSizeImages = new Set();
        // console.log('[OTK Viewer LIFECYCLE] renderAllMessages: Entered'); // Original log replaced by the one above
        if (!isManualViewerRefreshInProgress) {
            viewer.innerHTML = '';
            lastKnownMessageIds.clear();
            console.log('[OTK Viewer] Full render: Cleared viewer and lastKnownMessageIds.');
        }

        if (embedObserver) {
            embedObserver.disconnect(); // Disconnect previous observer if any
        }
        const observerOptions = {
            root: viewer, // Observe intersections within the viewer scrollable area
            rootMargin: '300px 0px 300px 0px', // Load when 300px from viewport edge
            threshold: 0.01 // Trigger when even 1% is visible
        };
        embedObserver = new IntersectionObserver(handleIntersection, observerOptions);

        // Gather all messages in one array with threadId info
        let allMessages = [];
        activeThreads.forEach(threadId => {
            const msgs = messagesByThreadId[threadId] || [];
            msgs.forEach(m => allMessages.push({ ...m, threadId }));
        });

        // Sort by time ascending
        allMessages.sort((a, b) => a.time - b.time);
        if (loadingOverlay) loadingOverlay.textContent = 'Processing media and attachments...';

        console.log(`[OTK Viewer Metrics] renderAllMessages: Processing ${allMessages.length} total messages for display.`);
        let attachmentStats = { images: 0, videos: 0, other: 0 };
        let embedCounts = { youtube: 0, twitch: 0, streamable: 0 };

        // Render all messages
        console.log(`[OTK Video Debug - renderAllMessages] About to render ${allMessages.length} messages. Parent frame context for these messages will be 'initial_render_frame'.`); // Added
        // console.log('[OTK Viewer LIFECYCLE] renderAllMessages: About to start allMessages.forEach loop. Message count: ' + allMessages.length); // Original log
        for (const msg of allMessages) { // Changed to for...of to use await inside
            console.log('[OTK Viewer LIFECYCLE] renderAllMessages: Loop: START processing message ID ' + msg.id);
            const msgEl = await renderMessageWithQuotes(msg, msg.threadId, 0, [], embedCounts, renderedFullSizeImages, 'initial_render_frame'); // Added await, Added parentFrameId
            // const msgEl = await renderMessageWithQuotes(...);
            console.log(`[OTK RenderAll - ${msg.id}] About to append msgEl. Valid DOM node: ${msgEl instanceof Node}. OuterHTML snippet: ${msgEl && msgEl.outerHTML ? msgEl.outerHTML.substring(0, 300) : 'N/A'}...`);
            // Selection class is now primarily handled by restoreSelectedMessageState upon loading all messages
            viewer.appendChild(msgEl);
            console.log(`[OTK Video Debug - renderAllMessages] Appended message element for ID ${msg.id}. Videos within should now attempt to load via their own .load() calls if correctly set up in createFullMedia.`); // Added
            // Inside the allMessages.forEach loop, after msgEl is created
            if (msg.attachment && msg.attachment.ext) {
                const ext = msg.attachment.ext.toLowerCase();
                if (['.jpg', '.jpeg', '.png', '.gif'].includes(ext)) {
                    attachmentStats.images++;
                } else if (['.webm', '.mp4'].includes(ext)) {
                    attachmentStats.videos++;
                } else {
                    attachmentStats.other++;
                }
            }
            console.log('[OTK Viewer LIFECYCLE] renderAllMessages: Loop: END processing message ID ' + msg.id);
        }
        console.log('[OTK Viewer LIFECYCLE] renderAllMessages: Successfully FINISHED allMessages loop.'); // Updated log
        if (loadingOverlay) loadingOverlay.textContent = 'Rendering content...';

        // Add listener for quote links to scroll to quoted message
        viewer.querySelectorAll('a.quote').forEach(link => {
            link.addEventListener('click', e => {
                e.preventDefault();
                const targetId = parseInt(link.dataset.postid);
                // Scroll to message with this id if found
                const targets = viewer.querySelectorAll('div');
                for (const el of targets) {
                    if (el.textContent.includes(`#${targetId} `)) {
                        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        // Highlight briefly
                        el.style.backgroundColor = '#ffff99';
                        setTimeout(() => {
                            el.style.backgroundColor = '';
                        }, 1500);
                        break;
                    }
                }
            });
        });

        console.log('[OTK Viewer Metrics] renderAllMessages: Attachment stats from processed messages:');
        console.log(`    - Images: ${attachmentStats.images}`);
        console.log(`    - Videos: ${attachmentStats.videos}`);
        console.log(`    - Other: ${attachmentStats.other}`);
        console.log('[OTK Viewer Metrics] renderAllMessages: Embed counts from processed messages:');
        console.log(`    - YouTube: ${embedCounts.youtube}`);
        console.log(`    - Twitch: ${embedCounts.twitch}`);
        console.log(`    - Streamable: ${embedCounts.streamable}`);
        try {
            const renderedMessageElements = viewer.querySelectorAll('div[data-message-id]');
            console.log(`[OTK Viewer Metrics] renderAllMessages: Rendered ${renderedMessageElements.length} top-level message DOM elements.`);
        } catch(e) {
            console.error('[OTK Viewer Metrics] Error counting rendered message elements:', e);
        }

        // After all messages are in the DOM, process any Twitter embed placeholders
        if (!isManualViewerRefreshInProgress) { // Only for full renders
            lastKnownMessageIds.clear(); // Clear again just in case, then populate
            allMessages.forEach(msg => lastKnownMessageIds.add(String(msg.id)));
            console.log(`[OTK Viewer] Populated lastKnownMessageIds with ${lastKnownMessageIds.size} message IDs after full render.`);
        }
        
        showLoadingOverlay("Processing tweets and embeds..."); // Restored
        // console.log('[OTK Loading Debug] renderAllMessages: BEFORE await processTweetEmbeds'); // Kept for debugging if necessary
        await processTweetEmbeds(viewer); // Ensure this is awaited (already was)
        // console.log('[OTK Loading Debug] renderAllMessages: AFTER await processTweetEmbeds'); // Kept for debugging if necessary
        showLoadingOverlay("Finalizing view..."); // Restored
        // if (loadingOverlay) loadingOverlay.textContent = 'Finalizing view...'; // Removed

        console.log(`[OTK Tweet DEBUG - renderAllMessages] PRE-CALL ensureTwitterWidgetsLoaded. Viewer element:`, viewer, `Is viewer connected: ${viewer && viewer.isConnected}`);
        // await ensureTwitterWidgetsLoaded(); // This call was here, but it's also called inside processTweetEmbeds.
                                          // If ensureTwitterWidgetsLoaded is idempotent, this is fine.
                                          // For now, let's assume the one in processTweetEmbeds is the primary one.
        console.log(`[OTK Tweet DEBUG - renderAllMessages] Twitter widgets supposedly loaded (or will be by processTweetEmbeds). PRE-CALL processTweetEmbeds.`);
        await processTweetEmbeds(viewer); 
        console.log(`[OTK Tweet DEBUG - renderAllMessages] POST-CALL processTweetEmbeds.`);
        if (loadingOverlay) loadingOverlay.textContent = 'Finalizing view...';

        const currentPlaceholders = viewer.querySelectorAll('.embed-placeholder');
        console.log(`[OTK Viewer IO] Observing ${currentPlaceholders.length} media placeholders.`);
        currentPlaceholders.forEach(ph => {
            if (embedObserver) embedObserver.observe(ph);
        });

        if (!viewer.dataset.scrollListenerAttached) {
            // const debouncedViewerScrollHandler = debounce(handleViewerScroll, 500); // 500ms debounce
            // viewer.addEventListener('scroll', debouncedViewerScrollHandler);
            // viewer.dataset.scrollListenerAttached = 'true';
            // console.log('[OTK Viewer Scroll] Attached debounced scroll listener to viewer.');
            // New scroll logic does not require this listener.
        }

        // Call manageInitialScroll directly, it's async and will handle final overlay hide and viewer display
        await manageInitialScroll();
        console.log('[OTK Viewer LIFECYCLE] renderAllMessages: manageInitialScroll has completed.');
    }

async function appendNewMessagesToFrame() {
    console.log('[OTK Viewer] appendNewMessagesToFrame: Initiated.');
    showLoadingOverlay('Fetching new messages...'); 

    let currentActiveThreads = JSON.parse(localStorage.getItem(THREADS_KEY)) || [];
    let currentMessagesByThreadId = JSON.parse(localStorage.getItem(MESSAGES_KEY)) || {};
    let currentThreadColors = JSON.parse(localStorage.getItem(COLORS_KEY)) || {};

    let allCurrentMessages = [];
    currentActiveThreads.forEach(threadId => {
        const msgs = currentMessagesByThreadId[threadId] || [];
        msgs.forEach(m => allCurrentMessages.push({ ...m, threadId }));
    });
    allCurrentMessages.sort((a, b) => a.time - b.time);

    const newMessages = allCurrentMessages.filter(msg => !lastKnownMessageIds.has(String(msg.id)));

    if (newMessages.length === 0) {
        showLoadingOverlay('No new messages found.'); 
        setTimeout(hideLoadingOverlay, 2000); 
        console.log('[OTK Viewer] appendNewMessagesToFrame: No new messages found.');
        return false; 
    }

    console.log(`[OTK Viewer] appendNewMessagesToFrame: Found ${newMessages.length} new messages to append.`);
    showLoadingOverlay('Processing new messages...'); 

    const newFrame = document.createElement('div');
    newFrame.id = `otk-frame-${Date.now()}-${Math.random().toString(36).substring(2,7)}`;
    console.log('[OTK Viewer] appendNewMessagesToFrame: Created new frame (divider) with ID:', newFrame.id);
    const timestamp = new Date().toLocaleString();
    newFrame.innerHTML = `<hr style="border-top: 2px dashed #007bff; margin: 20px 0;"><p style="text-align: center; color: #007bff; font-weight: bold;">New messages loaded at ${timestamp} (Frame: ${newFrame.id})</p>`;
    newFrame.style.marginBottom = '20px';
    viewer.appendChild(newFrame); 

    const renderedFullSizeImagesThisBatch = new Set(); 
    let embedCountsThisBatch = { youtube: 0, twitch: 0, streamable: 0 };

    const newMessagesFragment = document.createDocumentFragment();
    const newPlaceholdersToObserve = []; 
    const collectedVideoElements = []; 

    for (const msg of newMessages) { // Changed to for...of to use await
        const msgEl = await renderMessageWithQuotes(msg, msg.threadId, 0, [], embedCountsThisBatch, renderedFullSizeImagesThisBatch, newFrame.id); // Added await
        // const msgEl = await renderMessageWithQuotes(...);
        console.log(`[OTK AppendFrame - ${msg.id}] About to append msgEl to fragment. Valid DOM node: ${msgEl instanceof Node}. OuterHTML snippet: ${msgEl && msgEl.outerHTML ? msgEl.outerHTML.substring(0, 300) : 'N/A'}...`);
        
        const placeholdersInMsg = msgEl.querySelectorAll('.embed-placeholder');
        placeholdersInMsg.forEach(ph => newPlaceholdersToObserve.push(ph));

        const videosInMsg = msgEl.querySelectorAll('video');
        videosInMsg.forEach(vid => collectedVideoElements.push(vid));
        
        newMessagesFragment.appendChild(msgEl); 
        lastKnownMessageIds.add(String(msg.id));
    }

    viewer.appendChild(newMessagesFragment); 
    console.log(`[OTK Viewer] Appended ${newMessages.length} new messages. lastKnownMessageIds size: ${lastKnownMessageIds.size}`);
    
    if (collectedVideoElements.length > 0) {
        console.log('[OTK Video Debug] appendNewMessagesToFrame: Processing', collectedVideoElements.length, 'collected video elements for frame', newFrame.id);
        collectedVideoElements.forEach(video => {
            console.log('[OTK Video Debug] appendNewMessagesToFrame: Found video in newly appended content. SRC:', video.src, 'ID:', video.id, '. Attaching event listeners and calling .load().');
            const newVideo = video.cloneNode(true); 
            if (video.parentNode) {
                video.parentNode.replaceChild(newVideo, video);
            } else {
                console.warn('[OTK Video Debug] appendNewMessagesToFrame: Original video has no parentNode before replacement. Video src:', video.src);
            }
            newVideo.onloadeddata = () => console.log('[OTK Video Debug] appendNewMessagesToFrame: onloadeddata event for video:', newVideo.src, 'Frame ID:', newFrame.id);
            newVideo.onerror = (e) => console.error('[OTK Video Debug] appendNewMessagesToFrame: onerror event for video:', newVideo.src, 'Error:', e, 'Frame ID:', newFrame.id);
            if (newVideo.src && (newVideo.src.startsWith('blob:') || newVideo.src.startsWith('http'))) {
                 console.log('[OTK Video Debug] appendNewMessagesToFrame: Attempting to load video:', newVideo.src);
                 newVideo.load();
            } else {
                 console.warn('[OTK Video Debug] appendNewMessagesToFrame: Video source is not a blob/http or is empty, not calling load():', newVideo.src);
            }
        });
    }
    
    showLoadingOverlay('Observing new media and processing embeds...'); 
    
    if (embedObserver && newPlaceholdersToObserve.length > 0) {
        console.log(`[OTK Viewer IO] Observing ${newPlaceholdersToObserve.length} new media placeholders added by append.`);
        newPlaceholdersToObserve.forEach(ph => embedObserver.observe(ph));
    } else {
        if (!embedObserver) console.warn("[OTK Viewer IO] embedObserver not initialized when trying to observe new placeholders in appendNewMessagesToFrame.");
        if (newPlaceholdersToObserve.length === 0) console.log("[OTK Viewer IO] No new placeholders to observe in appendNewMessagesToFrame.");
    }
    
    console.log('[OTK Viewer Tweets DEBUG] appendNewMessagesToFrame: Calling processTweetEmbeds for viewer div after appending new frame.');
    await processTweetEmbeds(viewer); 
    
    showLoadingOverlay('Finalizing new content display...');
    console.log('[OTK Viewer] appendNewMessagesToFrame: Finished processing new messages.');
    return true; 
}

    // Toggle viewer display
    async function toggleViewer(show, isAutoOpen = false) {
        console.log('[OTK Viewer EXECUTION] toggleViewer: Entered. typeof show:', typeof show, 'isAutoOpen:', isAutoOpen);
        const bar = document.getElementById('otk-thread-bar'); // Get the black bar
        console.log(`[OTK Viewer EXECUTION] toggleViewer: Current viewer.style.display is "${viewer.style.display}"`);
        let shouldShow;
        if (typeof show === 'boolean') {
            shouldShow = show;
            console.log(`[OTK Viewer EXECUTION] toggleViewer: 'show' parameter is boolean: ${shouldShow}`);
        } else {
            // If 'show' is not a boolean (e.g., an Event object or undefined), decide based on current display state
            shouldShow = (viewer.style.display === 'none' || viewer.style.display === '');
            console.log(`[OTK Viewer EXECUTION] toggleViewer: 'show' parameter is not boolean (type: ${typeof show}). Deciding based on display state. ShouldShow: ${shouldShow}`);
        }

        if (shouldShow) {
            console.log('[OTK Viewer EXECUTION] toggleViewer: Determined TO SHOW viewer.');
            localStorage.setItem('otkViewerVisible', 'true');
            if (loadingOverlay) {
                loadingOverlay.textContent = 'Loading messages...';
                loadingOverlay.style.setProperty('display', 'flex', 'important');
                console.log('[OTK Loading Indicator] Overlay shown by toggleViewer. Style display:', loadingOverlay.style.display);
                void loadingOverlay.offsetHeight; // Force reflow
            }
            
            // viewer.style.display = 'block'; // This line is REMOVED. Viewer will be shown by manageInitialScroll.
            try {
                console.log('[OTK Viewer EXECUTION] toggleViewer: About to call renderAllMessages. Current viewer innerHTML length (approx before renderAllMessages):', viewer.innerHTML.length);
                await renderAllMessages(); // Ensure this is awaited
                console.log('[OTK Viewer EXECUTION] toggleViewer: renderAllMessages call successfully completed.');
            } catch (error) {
                console.error('[OTK Viewer EXECUTION] toggleViewer: CRITICAL ERROR during renderAllMessages call:', error.message, error.stack);
                if (loadingOverlay) { 
                    loadingOverlay.textContent = 'Critical error during content rendering. Check console.';
                    loadingOverlay.style.setProperty('display', 'flex', 'important'); // Make sure overlay is visible for error
                }
                // IMPORTANT: Exit toggleViewer here if renderAllMessages fails catastrophically,
                // to prevent hiding the main page content or other unintended side effects.
                return; 
            }

            // Adjust viewer padding and hide other page elements
            const barElement = document.getElementById('otk-thread-bar'); // bar is already defined at function scope
            let calculatedPaddingTop = '60px'; // Default/fallback if bar not found or height is 0
            if (barElement && barElement.offsetHeight > 0) {
                calculatedPaddingTop = barElement.offsetHeight + 'px';
            }
            viewer.style.paddingTop = calculatedPaddingTop;
            viewer.style.paddingLeft = '20px'; // Ensure consistent padding
            viewer.style.paddingRight = '20px';
            viewer.style.paddingBottom = '10px';

            originalBodyOverflow = document.body.style.overflow;
            document.body.style.overflow = 'hidden';
            otherBodyNodes = [];
            Array.from(document.body.childNodes).forEach(node => {
                if (node !== viewer && node !== bar && node.nodeType === Node.ELEMENT_NODE) {
                    if (node.style && node.style.display !== 'none') {
                        otherBodyNodes.push({ node: node, originalDisplay: node.style.display });
                        node.style.display = 'none';
                    } else if (!node.style && node.tagName !== 'SCRIPT' && node.tagName !== 'LINK') {
                        otherBodyNodes.push({ node: node, originalDisplay: '' });
                        node.style.display = 'none';
                    }
                }
            });

            if (bar) { // 'bar' is already defined at the top of toggleViewer
                bar.style.zIndex = '10000';
            }
        } // END OF IF BLOCK TO SHOW VIEWER
        else { // Logic to HIDE viewer
            console.log('[OTK Viewer EXECUTION] toggleViewer: Determined TO HIDE viewer.');
            // ... (ensure this part remains correct as it was)
            console.log('[OTK Viewer] toggleViewer: Attempting to HIDE viewer.');
            viewer.style.paddingTop = '10px'; // Reset to default padding
            viewer.style.paddingLeft = '20px';
            viewer.style.paddingRight = '20px';
            viewer.style.paddingBottom = '10px';
            viewer.style.display = 'none';
            document.body.style.overflow = originalBodyOverflow;

            otherBodyNodes.forEach(item => {
                item.node.style.display = item.originalDisplay;
            });
            otherBodyNodes = [];

            if (bar) { // 'bar' is already defined
                bar.style.zIndex = '9999';
            }
            if (embedObserver) {
                console.log('[OTK Viewer IO] Disconnecting IntersectionObserver as viewer is hidden.');
                embedObserver.disconnect();
            }
            if (loadingOverlay) {
                // loadingOverlay.style.display = 'none'; // Replaced by helper
                hideLoadingOverlay();
                console.log('[OTK Loading Overlay] Overlay hidden by toggleViewer (hiding main viewer).');
            }
            localStorage.setItem('otkViewerVisible', 'false');
        }
    }

    // Listen for toggle event from thread tracker script
    window.addEventListener('otkToggleViewer', toggleViewer);

    // Auto-open viewer if it was visible before refresh
    const viewerWasVisible = localStorage.getItem('otkViewerVisible');
    console.log('[OTK Viewer] Init: viewerWasVisible from localStorage:', viewerWasVisible);
    const initialSelectedId = localStorage.getItem(SELECTED_MESSAGE_KEY); // Assuming SELECTED_MESSAGE_KEY is 'otkSelectedMessageId'
    console.log('[OTK Viewer] Init: initialSelectedId from localStorage:', initialSelectedId);
    if (viewerWasVisible === 'true') {
        console.log('[OTK Viewer EXECUTION] Initial load: viewerWasVisible is true. Delaying toggleViewer() call by 500ms.');
        setTimeout(() => {
            console.log('[OTK Viewer EXECUTION] Executing delayed toggleViewer() for initial auto-open.');
            toggleViewer(true, true); // Explicitly pass show=true, isAutoOpen=true
        }, 500); // Delay of 500 milliseconds
    }

    window.addEventListener('beforeunload', () => {
        if (viewer && viewer.style.display === 'block') { // Check if viewer exists and is visible
            // const capturedState = captureLineAnchoredScrollState();
            // if (capturedState) {
            //     localStorage.setItem(PAGE_REFRESH_ANCHOR_STATE_KEY, JSON.stringify(capturedState)); 
            //     console.log('[OTK Scroll Lines] Saved line anchored state for F5 refresh:', capturedState);
            // } else {
            //     localStorage.removeItem(PAGE_REFRESH_ANCHOR_STATE_KEY); 
            //     console.log('[OTK Scroll Lines] No valid anchor state captured for F5 refresh, cleared stale data.');
            // }
        } else {
            // If viewer is not visible, clear any previous F5 anchor state, as it's no longer relevant.
            // localStorage.removeItem(PAGE_REFRESH_ANCHOR_STATE_KEY); 
            // console.log('[OTK Scroll Lines] Viewer not visible on unload, cleared F5 anchor state.');
        }
    });

window.addEventListener('otkMessagesUpdated', async () => { // make it async
    console.log('[OTK Viewer EXECUTION] Event: otkMessagesUpdated received.');
    if (viewer.style.display === 'block') { // Check if viewer is active (it might be initially hidden by CSS now)
        const manualRefreshClicked = sessionStorage.getItem('otkManualRefreshClicked');
        
        // Always load latest data from localStorage before deciding action
        activeThreads = JSON.parse(localStorage.getItem(THREADS_KEY)) || [];
        messagesByThreadId = JSON.parse(localStorage.getItem(MESSAGES_KEY)) || {};
        threadColors = JSON.parse(localStorage.getItem(COLORS_KEY)) || {};

        if (manualRefreshClicked === 'true') {
            sessionStorage.removeItem('otkManualRefreshClicked'); 
            console.log('[OTK Viewer] Manual refresh trigger detected.');
            isManualViewerRefreshInProgress = true; 
            showLoadingOverlay('Refreshing content...'); 

            // const capturedAnchorState = captureLineAnchoredScrollState(); 
            // console.log('[OTK Scroll Lines] Captured anchor state for internal refresh:', capturedAnchorState);

            const newMessagesWereAppended = await appendNewMessagesToFrame();

            if (newMessagesWereAppended) {
                // if (capturedAnchorState) { 
                //     showLoadingOverlay('Restoring view position...'); 
                //     if (await restoreLineAnchoredScrollState(capturedAnchorState)) {
                //         console.log('[OTK Scroll Lines] Successfully restored scroll after internal refresh append using anchor state.');
                //     } else {
                //         console.warn('[OTK Scroll Lines] Failed to restore scroll using anchor state after internal refresh append.');
                //     }
                // }
                
                console.log('[OTK Loading] New messages appended. Adding SIGNIFICANT delay before hiding overlay.');
                showLoadingOverlay('Finalizing display...'); // Ensure text is updated before long delay
                await new Promise(r => setTimeout(r, 1000)); // INCREASED DELAY
                
                hideLoadingOverlay(); 
            }
            // If newMessagesWereAppended is false, appendNewMessagesToFrame handled its "No new messages" overlay
            
            isManualViewerRefreshInProgress = false; 
            console.log('[OTK Viewer] Manual refresh/append process complete.');

        } else { // This is a background update (not a manual click from tracker's refresh button)
            console.log('[OTK Viewer] Background update detected. Silently refreshing internal data from localStorage.');
            
            // Silently update internal variables
            activeThreads = JSON.parse(localStorage.getItem(THREADS_KEY)) || [];
            messagesByThreadId = JSON.parse(localStorage.getItem(MESSAGES_KEY)) || {};
            threadColors = JSON.parse(localStorage.getItem(COLORS_KEY)) || {};
            
            // DO NOT call renderAllMessages() here.
            // DO NOT show loadingOverlay here.
            
            // Optional: Could set a flag here to indicate new data is available for the manual refresh button.
            // For example:
            // if (newMessagesAreActuallyAvailable()) { // This function would need to compare current lastKnownMessageIds with new data
            //     setNewContentAvailableIndicator(true); 
            // }
            console.log('[OTK Viewer] Internal data silently updated from localStorage due to background sync.');
        }
    }
});

})();
