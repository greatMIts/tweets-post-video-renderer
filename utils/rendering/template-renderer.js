const fs = require('fs').promises;
const path = require('path');

/**
 * TemplateRenderer - A robust utility for rendering HTML templates with dynamic content injection
 *
 * Features:
 * - Template caching for performance
 * - HTML escaping for security
 * - Timestamp formatting
 * - Error handling and logging
 * - Async file operations
 */
class TemplateRenderer {
  /**
   * Create a new TemplateRenderer instance
   * @param {string} templatePath - Absolute path to the HTML template file
   */
  constructor(templatePath) {
    if (!templatePath) {
      throw new Error('Template path is required');
    }

    this.templatePath = templatePath;
    this.templateCache = null;
    this.isLoading = false;
    this.loadPromise = null;
  }

  /**
   * Load and cache the template from the file system
   * @returns {Promise<string>} The loaded template content
   * @throws {Error} If template file cannot be read
   */
  async loadTemplate() {
    // Return cached template if already loaded
    if (this.templateCache !== null) {
      return this.templateCache;
    }

    // If already loading, wait for the existing load promise
    if (this.isLoading && this.loadPromise) {
      return this.loadPromise;
    }

    this.isLoading = true;
    this.loadPromise = this._loadTemplateInternal();

    try {
      const template = await this.loadPromise;
      return template;
    } finally {
      this.isLoading = false;
      this.loadPromise = null;
    }
  }

  /**
   * Internal method to load template from file system
   * @private
   * @returns {Promise<string>} The template content
   */
  async _loadTemplateInternal() {
    try {
      console.log(`[TemplateRenderer] Loading template from: ${this.templatePath}`);

      // Verify file exists
      try {
        await fs.access(this.templatePath);
      } catch (error) {
        throw new Error(`Template file not found at path: ${this.templatePath}`);
      }

      // Read template file
      const template = await fs.readFile(this.templatePath, 'utf-8');

      if (!template || template.trim().length === 0) {
        throw new Error('Template file is empty');
      }

      this.templateCache = template;
      console.log(`[TemplateRenderer] Template loaded and cached successfully (${template.length} bytes)`);

      return template;
    } catch (error) {
      console.error(`[TemplateRenderer] Error loading template:`, error.message);
      throw new Error(`Failed to load template: ${error.message}`);
    }
  }

  /**
   * Escape HTML special characters to prevent XSS attacks
   * @param {string} text - Text to escape
   * @returns {string} Escaped text
   */
  escapeHtml(text) {
    if (text == null) {
      return '';
    }

    const str = String(text);
    const htmlEscapeMap = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#x27;',
      '/': '&#x2F;',
    };

    return str.replace(/[&<>"'/]/g, (char) => htmlEscapeMap[char]);
  }

  /**
   * Calculate dynamic font sizes based on tweet length
   * @param {string} tweetBody - The tweet text content
   * @returns {Object} Object containing calculated font sizes
   */
  calculateDynamicFontSizes(tweetBody) {
    const length = tweetBody.length;
    const lineCount = tweetBody.split('\n').length;

    // Estimate total content height needed
    // Base calculation on both character count and line count
    const contentScore = length + (lineCount * 50); // Lines add more height

    // Define size breakpoints
    // Short tweets (< 150 chars): Large text
    // Medium tweets (150-350 chars): Medium text
    // Long tweets (> 350 chars): Small text

    let tweetFontSize, nameFontSize, usernameFontSize, timestampFontSize, lineHeight;

    if (contentScore < 200) {
      // Short tweet - use large sizes
      tweetFontSize = 52;
      nameFontSize = 42;
      usernameFontSize = 36;
      timestampFontSize = 36;
      lineHeight = 1.4;
    } else if (contentScore < 400) {
      // Medium tweet - scale down
      tweetFontSize = 44;
      nameFontSize = 38;
      usernameFontSize = 32;
      timestampFontSize = 32;
      lineHeight = 1.35;
    } else if (contentScore < 600) {
      // Long tweet - smaller text
      tweetFontSize = 36;
      nameFontSize = 34;
      usernameFontSize = 28;
      timestampFontSize = 28;
      lineHeight = 1.3;
    } else if (contentScore < 900) {
      // Very long tweet - very small text
      tweetFontSize = 30;
      nameFontSize = 30;
      usernameFontSize = 26;
      timestampFontSize = 26;
      lineHeight = 1.25;
    } else {
      // Extremely long tweet - minimum readable size
      tweetFontSize = 26;
      nameFontSize = 28;
      usernameFontSize = 24;
      timestampFontSize = 24;
      lineHeight = 1.2;
    }

    console.log(`[TemplateRenderer] Dynamic sizing: ${length} chars, ${lineCount} lines, score: ${contentScore}`);
    console.log(`[TemplateRenderer] Font sizes: tweet=${tweetFontSize}px, name=${nameFontSize}px`);

    return {
      tweetFontSize,
      nameFontSize,
      usernameFontSize,
      timestampFontSize,
      lineHeight,
      contentScore
    };
  }

  /**
   * Format the current timestamp as "HH:MM · Mon DD, YYYY"
   * @returns {string} Formatted timestamp
   */
  formatTimestamp() {
    const now = new Date();

    // Format hours and minutes (HH:MM)
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const time = `${hours}:${minutes}`;

    // Format date (Mon DD, YYYY)
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const month = months[now.getMonth()];
    const day = now.getDate();
    const year = now.getFullYear();
    const date = `${month} ${day}, ${year}`;

    return `${time} · ${date}`;
  }

  /**
   * Render the template with provided data
   * @param {Object} data - Data object containing template values
   * @param {string} data.theme - Theme ('dark' or 'light')
   * @param {string} data.profilePhotoUrl - Profile photo URL
   * @param {string} data.profileName - Display name
   * @param {string} data.username - Username without @
   * @param {string} data.tweetBody - Tweet content
   * @returns {Promise<string>} Rendered HTML
   * @throws {Error} If required data fields are missing or template cannot be loaded
   */
  async render(data) {
    try {
      // Validate required data fields
      this._validateData(data);

      // Load template (from cache if available)
      const template = await this.loadTemplate();

      // Prepare data with proper escaping
      const sanitizedData = this._prepareData(data);

      // Generate timestamp
      const timestamp = this.formatTimestamp();

      // Calculate dynamic font sizes based on tweet length
      const sizes = this.calculateDynamicFontSizes(data.tweetBody);

      // Create dynamic CSS to inject
      const dynamicStyles = `
    <style>
      .tweet-content {
        font-size: ${sizes.tweetFontSize}px !important;
        line-height: ${sizes.lineHeight} !important;
      }
      .author-name {
        font-size: ${sizes.nameFontSize}px !important;
      }
      .username {
        font-size: ${sizes.usernameFontSize}px !important;
      }
      .tweet-timestamp {
        font-size: ${sizes.timestampFontSize}px !important;
      }
      .verified-badge {
        width: ${Math.round(sizes.nameFontSize * 1.05)}px !important;
        height: ${Math.round(sizes.nameFontSize * 1.05)}px !important;
      }
    </style>
  </head>`;

      // Replace all placeholders in the template
      let rendered = template;

      // Replace placeholders with actual values
      const replacements = {
        '{{theme}}': sanitizedData.theme, // theme is not escaped (it's validated)
        '{{profilePhotoUrl}}': sanitizedData.profilePhotoUrl, // URLs are escaped
        '{{profileName}}': sanitizedData.profileName,
        '{{username}}': sanitizedData.username,
        '{{tweetBody}}': sanitizedData.tweetBody, // Preserves line breaks
        '{{timestamp}}': timestamp, // Generated timestamp is safe
      };

      for (const [placeholder, value] of Object.entries(replacements)) {
        // Use global replace to handle multiple occurrences
        rendered = rendered.split(placeholder).join(value);
      }

      // Inject dynamic styles before closing </head> tag
      rendered = rendered.replace('</head>', dynamicStyles);

      // Verify all placeholders were replaced
      const remainingPlaceholders = rendered.match(/\{\{[^}]+\}\}/g);
      if (remainingPlaceholders) {
        console.warn(`[TemplateRenderer] Warning: Unreplaced placeholders found: ${remainingPlaceholders.join(', ')}`);
      }

      console.log(`[TemplateRenderer] Template rendered successfully with dynamic sizing`);
      return rendered;
    } catch (error) {
      console.error(`[TemplateRenderer] Error rendering template:`, error.message);
      throw error;
    }
  }

  /**
   * Validate required data fields
   * @private
   * @param {Object} data - Data object to validate
   * @throws {Error} If required fields are missing or invalid
   */
  _validateData(data) {
    if (!data || typeof data !== 'object') {
      throw new Error('Data must be a valid object');
    }

    const requiredFields = ['theme', 'profilePhotoUrl', 'profileName', 'username', 'tweetBody'];
    const missingFields = requiredFields.filter(field => !data.hasOwnProperty(field));

    if (missingFields.length > 0) {
      throw new Error(`Missing required fields: ${missingFields.join(', ')}`);
    }

    // Validate theme
    if (!['dark', 'light'].includes(data.theme)) {
      throw new Error(`Invalid theme: ${data.theme}. Must be 'dark' or 'light'`);
    }

    // Validate data types
    if (typeof data.profilePhotoUrl !== 'string' || data.profilePhotoUrl.trim() === '') {
      throw new Error('profilePhotoUrl must be a non-empty string');
    }

    if (typeof data.profileName !== 'string' || data.profileName.trim() === '') {
      throw new Error('profileName must be a non-empty string');
    }

    if (typeof data.username !== 'string' || data.username.trim() === '') {
      throw new Error('username must be a non-empty string');
    }

    if (typeof data.tweetBody !== 'string' || data.tweetBody.trim() === '') {
      throw new Error('tweetBody must be a non-empty string');
    }
  }

  /**
   * Prepare and sanitize data for template rendering
   * @private
   * @param {Object} data - Raw data object
   * @returns {Object} Sanitized data object
   */
  _prepareData(data) {
    return {
      theme: data.theme, // Theme is validated, not escaped (used as CSS class)
      profilePhotoUrl: this.escapeHtml(data.profilePhotoUrl),
      profileName: this.escapeHtml(data.profileName),
      username: this.escapeHtml(data.username),
      // Tweet body is escaped but line breaks are preserved
      tweetBody: this.escapeHtml(data.tweetBody),
    };
  }

  /**
   * Clear the cached template (useful for testing or if template file changes)
   */
  clearCache() {
    this.templateCache = null;
    console.log('[TemplateRenderer] Template cache cleared');
  }

  /**
   * Get cache status
   * @returns {boolean} True if template is cached
   */
  isCached() {
    return this.templateCache !== null;
  }
}

module.exports = { TemplateRenderer };
