/**
 * Webview HTML generator for the image viewer.
 *
 * Extracted from ExrEditorProvider.getHtmlForWebview (A1/S3) so it
 * can be shared by any EditorProvider that hosts ImageViewerCore.
 */

function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

/**
 * Generate the webview HTML for the image viewer.
 *
 * Pure function with no vscode import — takes pre-computed URIs so
 * callers (ExrEditorProvider, future LibRawEditorProvider) can use
 * their own vscode.Uri.joinPath + webview.asWebviewUri.
 *
 * @param scriptUri - Webview URI pointing to the bundled webview.js.
 * @param styleUri - Webview URI pointing to exr-viewer.css.
 * @param cspSource - The webview's CSP source string.
 */
export function getViewerHtml(scriptUri: { toString(): string }, styleUri: { toString(): string }, cspSource: string): string {

    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} data:; script-src 'nonce-${nonce}'; style-src ${cspSource} 'unsafe-inline';">
    <link href="${styleUri}" rel="stylesheet">
    <title>EXR Viewer</title>
</head>
<body>
    <div id="toolbar">
        <div class="toolbar-group">
            <label for="source-select">Source:</label>
            <select id="source-select"></select>
        </div>
        <div class="toolbar-group">
            <label for="display-select">Display:</label>
            <select id="display-select"></select>
        </div>
        <div class="toolbar-group">
            <label for="view-select">View:</label>
            <select id="view-select"></select>
        </div>
        <div class="toolbar-group">
            <span id="image-info"></span>
        </div>
        <div class="toolbar-group">
            <span id="color-space-info"></span>
        </div>
        <div class="toolbar-group toolbar-right">
            <button id="export-exr-btn" class="export-btn" title="Export as EXR (with DCTL applied)">Export EXR</button>
        </div>
    </div>
    <div class="main-content">
        <!-- Left Sidebar: Metadata -->
        <aside id="sidebar-left" class="sidebar sidebar-left open">
            <header class="sidebar-header">
                <span class="sidebar-title">Metadata</span>
                <button id="sidebar-left-toggle" class="sidebar-toggle" title="Toggle sidebar">&#9664;</button>
            </header>
            <div class="sidebar-content">
                <div class="sidebar-section">
                    <button class="section-header" data-section="image-info-section">
                        <span class="section-toggle">&#9660;</span>
                        <span class="section-title">Image Info</span>
                    </button>
                    <div id="image-info-section" class="section-content">
                        <div class="metadata-list" id="metadata-image-info"></div>
                    </div>
                </div>
            </div>
        </aside>
        <div id="resize-handle-left" class="resize-handle"></div>
        <div id="canvas-container">
            <canvas id="preview-canvas"></canvas>
            <!-- Loading Overlay (inside canvas container) -->
            <div id="loading-overlay" class="visible">
                <div class="spinner"></div>
                <div id="loading-text">Open an EXR file to view</div>
            </div>
        </div>
        <div id="resize-handle-right" class="resize-handle"></div>
        <!-- Right Sidebar: DCTL -->
        <aside id="sidebar-right" class="sidebar sidebar-right open">
            <header class="sidebar-header">
                <button id="sidebar-right-toggle" class="sidebar-toggle" title="Toggle sidebar">&#9654;</button>
                <span class="sidebar-title">DCTL</span>
            </header>
            <div class="sidebar-content">
                <div id="dctl-panel" class="dctl-panel disabled">
                    <div class="dctl-header">
                        <label class="dctl-enable">
                            <input type="checkbox" id="dctl-enabled" disabled>
                            <span>Enable</span>
                        </label>
                        <select id="dctl-file-select" class="dctl-file-select">
                            <option value="">-- Select DCTL --</option>
                        </select>
                        <button id="dctl-file-btn" class="dctl-file-btn" title="Browse for DCTL file">...</button>
                    </div>
                    <div class="dctl-colorspace">
                        <label for="dctl-colorspace">Working:</label>
                        <select id="dctl-colorspace">
                            <option value="ACES2065-1">ACES2065-1 (AP0)</option>
                            <option value="ACEScg" selected>ACEScg (AP1)</option>
                            <option value="ACEScc">ACEScc (Log)</option>
                            <option value="ACEScct">ACEScct (Log)</option>
                            <option value="linear_sRGB">Linear sRGB</option>
                        </select>
                    </div>
                    <div class="dctl-rgc">
                        <label class="dctl-rgc-enable">
                            <input type="checkbox" id="rgc-enabled">
                            <span>ACES 2.0 RGC</span>
                        </label>
                        <div class="dctl-rgc-options" id="rgc-options" style="display: none;">
                            <div class="dctl-rgc-row">
                                <label for="rgc-peak-luminance">Peak:</label>
                                <select id="rgc-peak-luminance">
                                    <option value="100" selected>100 nits (SDR)</option>
                                    <option value="500">500 nits</option>
                                    <option value="1000">1000 nits</option>
                                    <option value="2000">2000 nits</option>
                                    <option value="4000">4000 nits</option>
                                </select>
                            </div>
                        </div>
                    </div>
                    <div class="dctl-params-section">
                        <div class="dctl-params-header">UI Parameters</div>
                        <div id="dctl-params" class="dctl-params">
                            <span class="dctl-params-empty">Select a DCTL file to see parameters</span>
                        </div>
                    </div>
                </div>
            </div>
        </aside>
    </div>
    <div id="status-bar">
        <div class="zoom-controls">
            <button id="zoom-fit" class="zoom-btn" title="Fit to window">Fit</button>
            <button id="zoom-100" class="zoom-btn" title="100% zoom">1:1</button>
            <span id="zoom-info">100%</span>
        </div>
        <div class="hdr-controls">
            <button id="hdr-toggle" class="hdr-btn" title="Toggle HDR mode (extended tone mapping)">HDR</button>
        </div>
        <span id="pixel-info"></span>
    </div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
