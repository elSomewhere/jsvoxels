/**
 * WebGL Helper
 * This script provides tools for diagnosing WebGL issues and helping users enable WebGL.
 */

// Try to detect if the browser has WebGL availability issues
export function diagnoseWebGLIssues() {
    console.log("Diagnosing WebGL availability...");
    
    const results = {
        supported: false,
        issues: [],
        possibleFixesHTML: "",
        renderer: null,
        vendor: null,
        webglVersion: 0
    };
    
    try {
        // Create a test canvas
        const canvas = document.createElement('canvas');
        
        // Check if Canvas is supported
        if (!canvas || typeof canvas.getContext !== 'function') {
            results.issues.push("Canvas is not supported by your browser");
            return finishDiagnosis(results);
        }
        
        // Try to get a WebGL 2 context
        let gl = canvas.getContext('webgl2');
        
        if (gl) {
            results.supported = true;
            results.webglVersion = 2;
            logWebGLInfo(gl, results);
            return finishDiagnosis(results);
        }
        
        // Fall back to WebGL 1
        gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
        
        if (gl) {
            results.supported = true;
            results.webglVersion = 1;
            logWebGLInfo(gl, results);
            return finishDiagnosis(results);
        }
        
        // Check if WebGLRenderingContext exists at all
        if (!window.WebGLRenderingContext) {
            results.issues.push("Your browser does not support WebGL");
            results.possibleFixesHTML = getFixesForUnsupportedBrowser();
            return finishDiagnosis(results);
        }
        
        // At this point, WebGL exists but we couldn't get a context
        results.issues.push("WebGL is supported but disabled");
        
        // Check for browser-specific issues
        const browser = detectBrowser();
        results.possibleFixesHTML = getFixesForBrowser(browser);
        
        // Check if running in a headless browser or remote desktop
        if (isHeadlessBrowser()) {
            results.issues.push("Running in a headless browser or remote desktop session");
        }
        
        // Check if hardware acceleration might be disabled
        if (isHardwareAccelerationDisabled()) {
            results.issues.push("Hardware acceleration appears to be disabled");
        }
        
    } catch (e) {
        results.issues.push(`Error during WebGL detection: ${e.message}`);
    }
    
    return finishDiagnosis(results);
}

// Log WebGL info if available
function logWebGLInfo(gl, results) {
    try {
        // Try to get the debug info extension to get real GPU info
        const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
        
        if (debugInfo) {
            results.vendor = gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL);
            results.renderer = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL);
            
            // Check for software rendering
            if (results.renderer.includes('SwiftShader') || 
                results.renderer.includes('ANGLE') || 
                results.renderer.includes('llvmpipe') || 
                results.renderer.includes('Software')) {
                
                results.issues.push("Using software rendering instead of hardware acceleration");
            }
        } else {
            // Fallback to standard info
            results.vendor = gl.getParameter(gl.VENDOR);
            results.renderer = gl.getParameter(gl.RENDERER);
        }
        
        // Get WebGL max abilities
        results.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
        results.maxRenderbufferSize = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE);
        
        // Clean up
        try {
            const loseContext = gl.getExtension('WEBGL_lose_context');
            if (loseContext) {
                loseContext.loseContext();
            }
        } catch (e) {
            console.warn("Could not clean up WebGL context:", e);
        }
        
    } catch (e) {
        results.issues.push(`Error getting WebGL info: ${e.message}`);
    }
}

function finishDiagnosis(results) {
    // Log the results to console
    console.log("WebGL Diagnosis Results:", results);
    return results;
}

// Detect browser type
function detectBrowser() {
    const userAgent = navigator.userAgent;
    let browser = {
        name: "unknown",
        version: "unknown",
        platform: navigator.platform
    };
    
    if (userAgent.indexOf("Chrome") > -1) {
        browser.name = "chrome";
        browser.version = userAgent.match(/Chrome\/([0-9.]+)/)[1];
    } else if (userAgent.indexOf("Firefox") > -1) {
        browser.name = "firefox";
        browser.version = userAgent.match(/Firefox\/([0-9.]+)/)[1];
    } else if (userAgent.indexOf("Safari") > -1) {
        browser.name = "safari";
        browser.version = userAgent.match(/Version\/([0-9.]+)/)[1];
    } else if (userAgent.indexOf("MSIE") > -1 || userAgent.indexOf("Trident") > -1) {
        browser.name = "ie";
        if (userAgent.indexOf("MSIE") > -1) {
            browser.version = userAgent.match(/MSIE ([0-9.]+)/)[1];
        } else {
            browser.version = userAgent.match(/rv:([0-9.]+)/)[1];
        }
    } else if (userAgent.indexOf("Edge") > -1) {
        browser.name = "edge";
        browser.version = userAgent.match(/Edge\/([0-9.]+)/)[1];
    }
    
    return browser;
}

// Get browser-specific fixes
function getFixesForBrowser(browser) {
    let fixes = "";
    
    fixes += "<h3>How to enable WebGL</h3>";
    fixes += "<p>Your browser supports WebGL, but it appears to be disabled. Try the following:</p>";
    fixes += "<ul>";
    
    // Common fixes for all browsers
    fixes += "<li>Update your graphics drivers</li>";
    fixes += "<li>Make sure you're not using a remote desktop or virtual machine</li>";
    
    // Browser-specific fixes
    switch (browser.name) {
        case "chrome":
            fixes += "<li>In Chrome, visit <code>chrome://settings/system</code> and enable 'Use hardware acceleration when available'</li>";
            fixes += "<li>Type <code>chrome://flags</code> in the address bar and ensure 'Override software rendering list' is enabled</li>";
            fixes += "<li>Make sure 'Block sites from running WebGL' is disabled in your <strong>browser security settings</strong></li>";
            break;
            
        case "firefox":
            fixes += "<li>In Firefox, visit <code>about:config</code> and set <code>webgl.force-enabled</code> to <code>true</code></li>";
            fixes += "<li>Also set <code>layers.acceleration.force-enabled</code> to <code>true</code></li>";
            fixes += "<li>Ensure 'Use hardware acceleration when available' is enabled in Firefox settings</li>";
            break;
            
        case "safari":
            fixes += "<li>In Safari, enable 'Show Develop menu in menu bar' in Advanced settings</li>";
            fixes += "<li>Then go to Develop menu and enable 'WebGL'</li>";
            fixes += "<li>On macOS, enable 'Use hardware acceleration when available' in System Settings</li>";
            break;
            
        case "edge":
            fixes += "<li>In Edge, visit <code>edge://settings/system</code> and turn on 'Use hardware acceleration when available'</li>";
            fixes += "<li>Open <code>edge://flags</code> and make sure WebGL is not disabled</li>";
            break;
            
        case "ie":
            fixes += "<li>Internet Explorer has limited WebGL support. We recommend using a modern browser like Chrome or Firefox</li>";
            break;
            
        default:
            fixes += "<li>Check your browser settings to ensure hardware acceleration is enabled</li>";
            fixes += "<li>Try a different browser like Chrome or Firefox</li>";
    }
    
    fixes += "</ul>";
    
    return fixes;
}

// Get fixes for browsers that don't support WebGL at all
function getFixesForUnsupportedBrowser() {
    let fixes = "";
    
    fixes += "<h3>WebGL Not Supported</h3>";
    fixes += "<p>Your browser doesn't seem to support WebGL at all. Here's what you can do:</p>";
    fixes += "<ul>";
    fixes += "<li>Update your browser to the latest version</li>";
    fixes += "<li>Try a different browser like <a href='https://www.google.com/chrome/' target='_blank'>Chrome</a> or <a href='https://www.mozilla.org/firefox/' target='_blank'>Firefox</a></li>";
    fixes += "<li>Make sure your graphics drivers are up to date</li>";
    fixes += "</ul>";
    
    return fixes;
}

// Check if running in a headless browser
function isHeadlessBrowser() {
    // Various methods to detect headless browsers
    const userAgent = navigator.userAgent.toLowerCase();
    
    if (userAgent.includes('headless')) {
        return true;
    }
    
    // PhantomJS and similar
    if (window.callPhantom || window._phantom) {
        return true;
    }
    
    // Selenium and WebDriver
    if (navigator.webdriver) {
        return true;
    }
    
    return false;
}

// Try to detect if hardware acceleration is disabled
function isHardwareAccelerationDisabled() {
    // This is just a heuristic and not 100% reliable
    
    // Create a canvas and test a simple 2D operation that would be GPU accelerated
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    
    try {
        const ctx = canvas.getContext('2d');
        if (!ctx) return true;
        
        // Start performance measurement
        const start = performance.now();
        
        // Run a test operation - create a gradient and fill the canvas
        // This is typically accelerated on GPUs
        const gradient = ctx.createLinearGradient(0, 0, 64, 64);
        gradient.addColorStop(0, 'red');
        gradient.addColorStop(1, 'blue');
        
        // Do this multiple times to get a more reliable measurement
        for (let i = 0; i < 100; i++) {
            ctx.fillStyle = gradient;
            ctx.fillRect(0, 0, 64, 64);
        }
        
        const end = performance.now();
        const duration = end - start;
        
        // If it takes too long, it might be software rendering
        // This threshold is a guess and might need adjustment
        return duration > 50; // More than 50ms suggests software rendering
        
    } catch (e) {
        console.warn("Error testing hardware acceleration:", e);
        return true; // Assume disabled if we can't test properly
    }
}

// Create a user-friendly WebGL status check display
export function createWebGLStatusDisplay(container) {
    if (!container) {
        container = document.createElement('div');
        container.id = 'webgl-status';
        container.style.position = 'fixed';
        container.style.bottom = '10px';
        container.style.right = '10px';
        container.style.backgroundColor = 'rgba(0, 0, 0, 0.7)';
        container.style.color = 'white';
        container.style.padding = '10px';
        container.style.borderRadius = '5px';
        container.style.fontFamily = 'Arial, sans-serif';
        container.style.fontSize = '14px';
        container.style.zIndex = '9999';
        document.body.appendChild(container);
    }
    
    // Run the diagnosis
    const results = diagnoseWebGLIssues();
    
    // Create the status display HTML
    let html = '<h3 style="margin-top:0;">WebGL Status</h3>';
    
    if (results.supported) {
        html += `<p style="color:#4CAF50;">✓ WebGL ${results.webglVersion} supported</p>`;
        
        if (results.renderer) {
            html += `<p>GPU: ${results.renderer}</p>`;
        }
        
        if (results.issues.length > 0) {
            html += '<h4>Potential Issues:</h4>';
            html += '<ul>';
            results.issues.forEach(issue => {
                html += `<li>${issue}</li>`;
            });
            html += '</ul>';
        }
    } else {
        html += '<p style="color:#F44336;">✗ WebGL not available</p>';
        
        if (results.issues.length > 0) {
            html += '<h4>Issues:</h4>';
            html += '<ul>';
            results.issues.forEach(issue => {
                html += `<li>${issue}</li>`;
            });
            html += '</ul>';
        }
        
        html += results.possibleFixesHTML;
    }
    
    // Add a close button
    html += '<button id="close-webgl-status" style="display:block; margin:10px auto; padding:5px 10px;">Close</button>';
    
    // Set the HTML
    container.innerHTML = html;
    
    // Add event listener for the close button
    document.getElementById('close-webgl-status').addEventListener('click', () => {
        container.style.display = 'none';
    });
    
    return container;
}

// Attempt to enable WebGL by setting recommended browser settings
export function attemptToEnableWebGL() {
    const browser = detectBrowser();
    
    // Try to enable WebGL based on the browser
    switch (browser.name) {
        case "chrome":
            window.open('chrome://settings/system', '_blank');
            break;
            
        case "firefox":
            window.open('about:config', '_blank');
            break;
            
        case "safari":
            alert("Please enable WebGL in Safari:\n1. In Safari menu, select Preferences\n2. Go to Advanced tab\n3. Check 'Show Develop menu in menu bar'\n4. In the Develop menu, ensure WebGL is enabled");
            break;
            
        case "edge":
            window.open('edge://settings/system', '_blank');
            break;
            
        default:
            alert("Please enable hardware acceleration in your browser settings or try using Chrome or Firefox.");
    }
} 