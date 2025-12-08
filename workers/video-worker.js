const fs = require('fs').promises;
const path = require('path');
const { TemplateRenderer } = require('../utils/rendering/template-renderer.js');
const { ScreenshotGenerator } = require('../utils/rendering/screenshot-generator.js');
const { VideoComposer } = require('../utils/video/video-composer.js');
const { generateSecureFilename, generateDownloadUrl } = require('../utils/url-generator.js');

/**
 * VideoGenerationWorker - Background worker for processing video generation jobs
 *
 * This worker continuously monitors the job queue and processes pending video generation jobs.
 * It handles the complete pipeline from HTML rendering to video composition and storage.
 *
 * Features:
 * - Concurrent job processing with configurable limits
 * - Comprehensive error handling and recovery
 * - Detailed progress tracking at each step
 * - Automatic cleanup of temporary files
 * - Production-ready logging
 */
class VideoGenerationWorker {
  /**
   * Creates a VideoGenerationWorker instance
   * @param {Object} dependencies - Worker dependencies
   * @param {Object} dependencies.jobManager - JobManager instance for job lifecycle management
   * @param {Object} dependencies.storageProvider - Storage provider instance for file persistence
   * @param {string} dependencies.templatePath - Absolute path to the HTML template file
   * @param {string} dependencies.audioPath - Absolute path to the background music file
   * @param {number} [dependencies.maxConcurrentJobs=2] - Maximum number of jobs to process concurrently
   * @param {number} [dependencies.pollInterval=5000] - Polling interval in milliseconds
   */
  constructor(dependencies) {
    // Validate required dependencies
    if (!dependencies) {
      throw new Error('Dependencies object is required');
    }

    if (!dependencies.jobManager) {
      throw new Error('jobManager is required');
    }

    if (!dependencies.storageProvider) {
      throw new Error('storageProvider is required');
    }

    if (!dependencies.templatePath) {
      throw new Error('templatePath is required');
    }

    if (!dependencies.audioPath) {
      throw new Error('audioPath is required');
    }

    // Store dependencies
    this.jobManager = dependencies.jobManager;
    this.storageProvider = dependencies.storageProvider;
    this.templatePath = dependencies.templatePath;
    this.audioPath = dependencies.audioPath;
    this.maxConcurrentJobs = dependencies.maxConcurrentJobs || 2;
    this.pollInterval = dependencies.pollInterval || 5000;

    // Worker state
    this.isRunning = false;
    this.intervalId = null;
    this.currentJobCount = 0;
    this.processingJobs = new Set(); // Track jobs currently being processed

    // Get storage TTL from environment
    this.storageTtlHours = parseInt(process.env.STORAGE_TTL_HOURS || '24', 10);

    // Get base URL for download URLs
    this.baseUrl = process.env.BASE_URL || 'http://localhost:3000';

    console.log('[VideoGenerationWorker] Worker initialized with configuration:');
    console.log(`  - Template path: ${this.templatePath}`);
    console.log(`  - Audio path: ${this.audioPath}`);
    console.log(`  - Max concurrent jobs: ${this.maxConcurrentJobs}`);
    console.log(`  - Poll interval: ${this.pollInterval}ms`);
    console.log(`  - Storage TTL: ${this.storageTtlHours} hours`);
    console.log(`  - Base URL: ${this.baseUrl}`);
  }

  /**
   * Starts the worker loop
   * Begins polling the job queue at regular intervals
   */
  start() {
    if (this.isRunning) {
      console.warn('[VideoGenerationWorker] Worker is already running');
      return;
    }

    console.log('[VideoGenerationWorker] Starting worker...');
    this.isRunning = true;

    // Start the polling loop
    this.intervalId = setInterval(() => {
      this.processQueue().catch(error => {
        console.error('[VideoGenerationWorker] Error in processQueue:', error);
      });
    }, this.pollInterval);

    // Process immediately on start
    this.processQueue().catch(error => {
      console.error('[VideoGenerationWorker] Error in initial processQueue:', error);
    });

    console.log('[VideoGenerationWorker] Worker started successfully');
  }

  /**
   * Stops the worker
   * Clears the polling interval and waits for current jobs to complete
   */
  async stop() {
    if (!this.isRunning) {
      console.warn('[VideoGenerationWorker] Worker is not running');
      return;
    }

    console.log('[VideoGenerationWorker] Stopping worker...');
    this.isRunning = false;

    // Clear the interval
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    // Wait for currently processing jobs to complete
    const maxWaitTime = 60000; // 60 seconds
    const waitInterval = 1000; // 1 second
    let elapsed = 0;

    while (this.currentJobCount > 0 && elapsed < maxWaitTime) {
      console.log(`[VideoGenerationWorker] Waiting for ${this.currentJobCount} jobs to complete...`);
      await new Promise(resolve => setTimeout(resolve, waitInterval));
      elapsed += waitInterval;
    }

    if (this.currentJobCount > 0) {
      console.warn(`[VideoGenerationWorker] Stopped with ${this.currentJobCount} jobs still processing`);
    } else {
      console.log('[VideoGenerationWorker] All jobs completed, worker stopped');
    }
  }

  /**
   * Checks for pending jobs and processes them
   * Respects maxConcurrentJobs limit
   */
  async processQueue() {
    try {
      // Skip if we're at capacity
      if (this.currentJobCount >= this.maxConcurrentJobs) {
        return;
      }

      // Get pending jobs
      const pendingJobs = this.jobManager.getJobsByStatus('pending');

      if (pendingJobs.length === 0) {
        return;
      }

      console.log(`[VideoGenerationWorker] Found ${pendingJobs.length} pending job(s)`);

      // Calculate how many jobs we can process
      const availableSlots = this.maxConcurrentJobs - this.currentJobCount;
      const jobsToProcess = pendingJobs.slice(0, availableSlots);

      console.log(`[VideoGenerationWorker] Processing ${jobsToProcess.length} job(s) (${availableSlots} slots available)`);

      // Process jobs in parallel
      const processingPromises = jobsToProcess.map(job => {
        // Skip if already processing (race condition protection)
        if (this.processingJobs.has(job.jobId)) {
          console.warn(`[VideoGenerationWorker] Job ${job.jobId} is already being processed, skipping`);
          return Promise.resolve();
        }

        this.processingJobs.add(job.jobId);
        return this.processJob(job.jobId).finally(() => {
          this.processingJobs.delete(job.jobId);
        });
      });

      await Promise.allSettled(processingPromises);

    } catch (error) {
      console.error('[VideoGenerationWorker] Error in processQueue:', error);
    }
  }

  /**
   * Processes a single job through the complete video generation pipeline
   * @param {string} jobId - The job ID to process
   */
  async processJob(jobId) {
    this.currentJobCount++;
    console.log(`[VideoGenerationWorker] ===== Starting job ${jobId} =====`);
    console.log(`[VideoGenerationWorker] Current job count: ${this.currentJobCount}/${this.maxConcurrentJobs}`);

    let screenshotPath = null;
    let videoPath = null;

    try {
      // Get job details
      const job = this.jobManager.getJob(jobId);
      if (!job) {
        throw new Error(`Job ${jobId} not found`);
      }

      console.log(`[VideoGenerationWorker] Job ${jobId} details:`, JSON.stringify(job.request, null, 2));

      // Update status to processing
      this.jobManager.updateJobStatus(jobId, 'processing');
      console.log(`[VideoGenerationWorker] Job ${jobId} status updated to 'processing'`);

      // ============================================================
      // STEP 1: Generate screenshot (20%)
      // ============================================================
      this.jobManager.updateJobProgress(jobId, 'generating_screenshot', 20);
      console.log(`[VideoGenerationWorker] Job ${jobId} - Step 1: Generating screenshot`);

      // Create template renderer
      const templateRenderer = new TemplateRenderer(this.templatePath);

      // Render HTML with job data
      const html = await templateRenderer.render({
        theme: job.request.theme || 'dark',
        profilePhotoUrl: job.request.profilePhotoUrl,
        profileName: job.request.profileName,
        username: job.request.username,
        tweetBody: job.request.tweetBody,
      });

      console.log(`[VideoGenerationWorker] Job ${jobId} - HTML rendered successfully`);

      // Generate screenshot
      screenshotPath = `/tmp/${jobId}-screenshot.png`;
      const screenshotGenerator = new ScreenshotGenerator();
      await screenshotGenerator.generate(html, screenshotPath);

      console.log(`[VideoGenerationWorker] Job ${jobId} - Screenshot saved to: ${screenshotPath}`);

      // ============================================================
      // STEP 2: Compose video (60%)
      // ============================================================
      this.jobManager.updateJobProgress(jobId, 'composing_video', 60);
      console.log(`[VideoGenerationWorker] Job ${jobId} - Step 2: Composing video`);

      // Initialize video composer
      const videoComposer = new VideoComposer();
      await videoComposer.initialize();

      // Generate video
      videoPath = `/tmp/${jobId}-video.mp4`;
      await videoComposer.compose(screenshotPath, this.audioPath, videoPath, {
        duration: 86400,
        width: 1080,
        height: 1920,
        fps: 30,
        fadeInDuration: 0.5,
        fadeOutDuration: 0.5,
        audioVolume: 0.3,
      });

      console.log(`[VideoGenerationWorker] Job ${jobId} - Video composed successfully: ${videoPath}`);

      // ============================================================
      // STEP 3: Save to storage (80%)
      // ============================================================
      this.jobManager.updateJobProgress(jobId, 'saving_file', 80);
      console.log(`[VideoGenerationWorker] Job ${jobId} - Step 3: Saving to storage`);

      // Read video file
      const videoBuffer = await fs.readFile(videoPath);
      console.log(`[VideoGenerationWorker] Job ${jobId} - Video file read: ${videoBuffer.length} bytes`);

      // Generate secure filename
      const filename = generateSecureFilename(jobId, 'mp4');
      console.log(`[VideoGenerationWorker] Job ${jobId} - Secure filename: ${filename}`);

      // Calculate expiration time
      const expiresAt = new Date(Date.now() + this.storageTtlHours * 60 * 60 * 1000).toISOString();

      // Save to storage
      const saveResult = await this.storageProvider.save(filename, videoBuffer, {
        jobId,
        contentType: 'video/mp4',
        duration: 86400,  // 24 hours - plenty of time to download
        resolution: '1080x1920',
      });

      console.log(`[VideoGenerationWorker] Job ${jobId} - File saved to storage:`, saveResult);

      // Generate download URL
      const downloadUrl = generateDownloadUrl(this.baseUrl, filename);
      console.log(`[VideoGenerationWorker] Job ${jobId} - Download URL: ${downloadUrl}`);

      // Get file size
      const fileSize = videoBuffer.length;

      // ============================================================
      // STEP 4: Complete job
      // ============================================================
      console.log(`[VideoGenerationWorker] Job ${jobId} - Step 4: Marking job as completed`);

      this.jobManager.setJobCompleted(jobId, {
        filename,
        downloadUrl,
        expiresAt,
        fileSize,
        duration: 86400,
        resolution: '1080x1920',
      });

      console.log(`[VideoGenerationWorker] Job ${jobId} - Completed successfully`);

      // ============================================================
      // STEP 5: Cleanup temporary files
      // ============================================================
      await this._cleanupTempFiles(jobId, screenshotPath, videoPath);

      console.log(`[VideoGenerationWorker] ===== Job ${jobId} finished successfully =====`);

    } catch (error) {
      console.error(`[VideoGenerationWorker] Job ${jobId} failed with error:`, error);
      console.error(`[VideoGenerationWorker] Error stack:`, error.stack);

      // Set job as failed
      try {
        this.jobManager.setJobFailed(jobId, error.message, error.stack);
        console.log(`[VideoGenerationWorker] Job ${jobId} marked as failed in job manager`);
      } catch (managerError) {
        console.error(`[VideoGenerationWorker] Failed to update job status for ${jobId}:`, managerError);
      }

      // Cleanup temporary files even on failure
      await this._cleanupTempFiles(jobId, screenshotPath, videoPath);

      console.error(`[VideoGenerationWorker] ===== Job ${jobId} finished with error =====`);

    } finally {
      this.currentJobCount--;
      console.log(`[VideoGenerationWorker] Job ${jobId} - Released job slot. Current count: ${this.currentJobCount}/${this.maxConcurrentJobs}`);
    }
  }

  /**
   * Cleans up temporary files created during job processing
   * @private
   * @param {string} jobId - The job ID
   * @param {string} screenshotPath - Path to screenshot file
   * @param {string} videoPath - Path to video file
   */
  async _cleanupTempFiles(jobId, screenshotPath, videoPath) {
    console.log(`[VideoGenerationWorker] Job ${jobId} - Cleaning up temporary files`);

    const filesToDelete = [screenshotPath, videoPath].filter(Boolean);

    for (const filePath of filesToDelete) {
      try {
        await fs.access(filePath);
        await fs.unlink(filePath);
        console.log(`[VideoGenerationWorker] Job ${jobId} - Deleted temp file: ${filePath}`);
      } catch (error) {
        if (error.code === 'ENOENT') {
          console.log(`[VideoGenerationWorker] Job ${jobId} - Temp file does not exist (already deleted?): ${filePath}`);
        } else {
          console.error(`[VideoGenerationWorker] Job ${jobId} - Failed to delete temp file ${filePath}:`, error.message);
        }
      }
    }

    console.log(`[VideoGenerationWorker] Job ${jobId} - Cleanup completed`);
  }

  /**
   * Gets the current worker status
   * @returns {Object} Worker status information
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      currentJobCount: this.currentJobCount,
      maxConcurrentJobs: this.maxConcurrentJobs,
      pollInterval: this.pollInterval,
      processingJobs: Array.from(this.processingJobs),
    };
  }
}

module.exports = { VideoGenerationWorker };
