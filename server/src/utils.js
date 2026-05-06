const path = require('path');

/**
 * Clean a string to be a valid filename, removing illegal characters and emojis.
 * Also prevents directory traversal by removing ".." and "." segments.
 * @param {string} string - the string to replace 
 * @returns {string} - returns a cleaned string
 */
function cleanFilename(string) {
    if (typeof string !== 'string') return '';
    
    // 1. Remove emojis and special Unicode characters
    let cleaned = string.replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '');
    
    // 2. Replace slashes and backslashes with dashes (to preserve readability of dates/paths in titles)
    cleaned = cleaned.replace(/[/\\]/g, '-');

    // 3. Remove illegal characters for Windows/Linux filesystems
    cleaned = cleaned.replaceAll(/[<>:"|?*\x00-\x1F]/g, '');
    
    // 4. Remove traversal attempts and problematic dots/spaces
    cleaned = cleaned.replace(/\.\./g, '') 
                     .replace(/^\.+|\.+$/g, '')
                     .trim();

    return cleaned || 'Untitled';
}

/**
 * Safely sanitizes a relative path by cleaning each segment individually.
 * This prevents path poisoning while allowing the creation to proceed.
 * @param {string} relativePath - The requested relative path
 * @returns {string} - A sanitized version of the relative path
 */
function sanitizePath(relativePath) {
    if (typeof relativePath !== 'string') return '';
    
    // Split into segments and clean each one
    const segments = relativePath.split(/[/\\]/);
    const safeSegments = segments
        .map(segment => cleanFilename(segment))
        .filter(segment => segment !== '' && segment !== 'Untitled');

    return safeSegments.join(path.sep);
}

module.exports = {
    cleanFilename,
    sanitizePath
};