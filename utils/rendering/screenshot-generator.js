const puppeteer = require('puppeteer');
const { ChromeDetector } = require('../chrome-detector.js');

/**
 * ScreenshotGenerator - Utility for rendering HTML to PNG screenshots using Puppeteer
 *
 * This class handles the generation of high-quality screenshots from HTML content,
 * optimized for social media content (1080x1920 Retina quality).
 */
class ScreenshotGenerator {
  /**
   * Generate a screenshot from HTML content
   *
   * @param {string} html - The HTML content to render
   * @param {string} outputPath - The file path where the screenshot should be saved
   * @returns {Promise<string>} The output path of the generated screenshot
   * @throws {Error} If screenshot generation fails
   */
  async generate(html, outputPath) {
    console.log('[ScreenshotGenerator] Starting screenshot generation');
    console.log(`[ScreenshotGenerator] Output path: ${outputPath}`);

    let browser = null;

    try {
      // Get launch options from ChromeDetector
      const baseLaunchOptions = await ChromeDetector.createLaunchOptions(true);

      // Enhance launch options with additional args
      const launchOptions = {
        ...baseLaunchOptions,
        args: [
          ...(baseLaunchOptions.args || []),
          '--single-process'
        ]
      };

      console.log('[ScreenshotGenerator] Launching browser with options:',
        JSON.stringify(launchOptions, null, 2));

      // Launch browser
      browser = await puppeteer.launch(launchOptions);
      console.log('[ScreenshotGenerator] Browser launched successfully');

      // Create new page
      const page = await browser.newPage();
      console.log('[ScreenshotGenerator] New page created');

      // Set viewport for optimal social media rendering (1080x1920 Retina)
      await page.setViewport({
        width: 1080,
        height: 1920,
        deviceScaleFactor: 2
      });
      console.log('[ScreenshotGenerator] Viewport configured: 1080x1920 @ 2x scale');

      // Set HTML content
      console.log('[ScreenshotGenerator] Setting HTML content...');
      await page.setContent(html, {
        waitUntil: 'networkidle0',
        timeout: 30000
      });
      console.log('[ScreenshotGenerator] HTML content loaded, network idle');

      // Wait for avatar selector to ensure profile photo loads
      console.log('[ScreenshotGenerator] Waiting for .avatar selector...');
      try {
        await page.waitForSelector('.avatar', {
          timeout: 10000
        });
        console.log('[ScreenshotGenerator] Avatar element loaded');
      } catch (error) {
        console.warn('[ScreenshotGenerator] Warning: Avatar selector not found within timeout:', error.message);
        console.warn('[ScreenshotGenerator] Continuing with screenshot generation...');
      }

      // Additional wait for rendering to complete
      console.log('[ScreenshotGenerator] Waiting additional 500ms for rendering...');
      await new Promise(resolve => setTimeout(resolve, 500));

      // Take screenshot
      console.log('[ScreenshotGenerator] Capturing screenshot...');
      await page.screenshot({
        path: outputPath,
        type: 'png',
        fullPage: false,
        omitBackground: false
      });
      console.log(`[ScreenshotGenerator] Screenshot saved successfully to: ${outputPath}`);

      return outputPath;

    } catch (error) {
      console.error('[ScreenshotGenerator] Error during screenshot generation:', error);
      console.error('[ScreenshotGenerator] Error stack:', error.stack);
      throw new Error(`Failed to generate screenshot: ${error.message}`);

    } finally {
      // Ensure browser is closed even if an error occurs
      if (browser) {
        try {
          console.log('[ScreenshotGenerator] Closing browser...');
          await browser.close();
          console.log('[ScreenshotGenerator] Browser closed successfully');
        } catch (closeError) {
          console.error('[ScreenshotGenerator] Error closing browser:', closeError);
          // Don't throw here, just log the error
        }
      }
    }
  }
}

module.exports = { ScreenshotGenerator };
