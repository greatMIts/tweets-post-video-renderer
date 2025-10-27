#!/usr/bin/env node
/**
 * Twitter Video Generator API Server
 * Main Express application server
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs').promises;

// Import utilities
const { jobManager } = require('./utils/job-manager');
const { verifySignature } = require('./utils/signature-verifier');
const { createDefaultStorageProvider } = require('./utils/storage');
const { CleanupScheduler } = require('./utils/cleanup-scheduler');
const { isValidFilename } = require('./utils/url-generator');

// Import worker
const { VideoGenerationWorker } = require('./workers/video-worker');

// Configuration
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const TEMPLATE_PATH = process.env.TWEET_TEMPLATE_PATH || path.join(__dirname, 'claude', 'twitter-post-template.html');
const AUDIO_PATH = process.env.BACKGROUND_MUSIC_PATH || path.join(__dirname, 'assets', 'background-music.mp3');

// Initialize Express app
const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Request logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} - ${res.statusCode} (${duration}ms)`);
  });
  next();
});

// Initialize components
let storage;
let worker;
let cleanupScheduler;
let server;

/**
 * Initialize all application components
 */
async function initializeComponents() {
  try {
    console.log('[Server] Initializing components...');

    // Ensure storage directory exists and is writable
    const storagePath = process.env.STORAGE_PATH || '/data/videos';
    try {
      await fs.mkdir(storagePath, { recursive: true, mode: 0o755 });
      // Test write permissions
      const testFile = path.join(storagePath, '.write-test');
      await fs.writeFile(testFile, 'test');
      await fs.unlink(testFile);
      console.log('[Server] ✓ Storage directory verified:', storagePath);
    } catch (error) {
      console.error('[Server] ⚠️  Storage directory check failed:', error.message);
      if (error.code === 'EACCES') {
        console.error('[Server] Permission denied. Using fallback directory...');
        // Fallback to /tmp for Railway if /data has permission issues
        process.env.STORAGE_PATH = '/tmp/videos';
        await fs.mkdir('/tmp/videos', { recursive: true, mode: 0o755 });
        console.log('[Server] ✓ Using fallback storage:', '/tmp/videos');
      } else {
        throw error;
      }
    }

    // Initialize storage provider
    storage = createDefaultStorageProvider();
    console.log('[Server] ✓ Storage provider initialized');

    // Verify template exists
    try {
      await fs.access(TEMPLATE_PATH);
      console.log('[Server] ✓ Tweet template found:', TEMPLATE_PATH);
    } catch (error) {
      console.warn('[Server] ⚠️  Tweet template not found:', TEMPLATE_PATH);
      console.warn('[Server]    Using default template path');
    }

    // Verify audio exists
    try {
      await fs.access(AUDIO_PATH);
      console.log('[Server] ✓ Background music found:', AUDIO_PATH);
    } catch (error) {
      console.warn('[Server] ⚠️  Background music not found:', AUDIO_PATH);
      console.warn('[Server]    Videos will be generated without audio');
    }

    // Initialize background worker
    worker = new VideoGenerationWorker({
      jobManager,
      storageProvider: storage,
      templatePath: TEMPLATE_PATH,
      audioPath: AUDIO_PATH,
      maxConcurrentJobs: parseInt(process.env.MAX_CONCURRENT_JOBS) || 2,
      pollInterval: parseInt(process.env.WORKER_POLL_INTERVAL_MS) || 5000,
    });
    worker.start();
    console.log('[Server] ✓ Background worker started');

    // Initialize cleanup scheduler
    cleanupScheduler = new CleanupScheduler(
      storage,
      jobManager,
      parseInt(process.env.CLEANUP_INTERVAL_MINUTES) || 60,
      parseInt(process.env.JOB_CLEANUP_HOURS) || 72
    );
    cleanupScheduler.start();
    console.log('[Server] ✓ Cleanup scheduler started');

    console.log('[Server] All components initialized successfully');
  } catch (error) {
    console.error('[Server] Failed to initialize components:', error);
    throw error;
  }
}

// ============================================================================
// API Routes
// ============================================================================

/**
 * POST /generate-video
 * Creates a new video generation job
 */
app.post('/generate-video', verifySignature, validateVideoRequest, async (req, res) => {
  try {
    const { tweetBody, profilePhotoUrl, profileName, username, theme } = req.body;

    // Create job
    const jobId = jobManager.createJob({
      tweetBody,
      profilePhotoUrl,
      profileName,
      username,
      theme: theme || 'dark',
    });

    const job = jobManager.getJob(jobId);

    // Return job info
    res.status(202).json({
      success: true,
      jobId: job.jobId,
      status: job.status,
      createdAt: job.createdAt,
      estimatedCompletionTime: '30-60s',
    });

    console.log(`[API] Video generation job created: ${jobId}`);
  } catch (error) {
    console.error('[API] Error creating job:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to create video generation job',
      timestamp: new Date().toISOString(),
    });
  }
});

/**
 * GET /job/:jobId
 * Retrieves job status and details
 */
app.get('/job/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;

    const job = jobManager.getJob(jobId);

    if (!job) {
      return res.status(404).json({
        error: 'Not Found',
        message: `Job ${jobId} not found`,
        timestamp: new Date().toISOString(),
      });
    }

    // Build response based on job status
    const response = {
      jobId: job.jobId,
      status: job.status,
      createdAt: job.createdAt,
    };

    if (job.status === 'pending') {
      response.message = 'Job is waiting in queue';
    } else if (job.status === 'processing') {
      response.currentStep = job.currentStep;
      response.progress = job.progress;
      response.message = getProgressMessage(job.currentStep);
    } else if (job.status === 'completed') {
      response.completedAt = job.completedAt;
      response.downloadUrl = job.result.downloadUrl;
      response.expiresAt = job.result.expiresAt;
      response.fileSize = job.result.fileSize;
      response.duration = job.result.duration;
      response.resolution = job.result.resolution;
    } else if (job.status === 'failed') {
      response.failedAt = job.error.failedAt;
      response.error = job.error.message;
      response.message = 'Video generation failed';
    }

    res.json(response);
  } catch (error) {
    console.error('[API] Error retrieving job:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to retrieve job status',
      timestamp: new Date().toISOString(),
    });
  }
});

/**
 * GET /download/:filename
 * Downloads a generated video file
 */
app.get('/download/:filename', async (req, res) => {
  try {
    const { filename } = req.params;

    // Validate filename
    if (!isValidFilename(filename)) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Invalid filename',
        timestamp: new Date().toISOString(),
      });
    }

    // Check if file exists
    const exists = await storage.exists(filename);
    if (!exists) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'File not found or has expired',
        timestamp: new Date().toISOString(),
      });
    }

    // Get file
    const buffer = await storage.get(filename);
    const metadata = await storage.getMetadata(filename);

    // Set response headers
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', buffer.length);

    if (metadata && metadata.size) {
      res.setHeader('X-File-Size', metadata.size);
    }

    // Send file
    res.send(buffer);
    console.log(`[API] File downloaded: ${filename}`);
  } catch (error) {
    console.error('[API] Error downloading file:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to download file',
      timestamp: new Date().toISOString(),
    });
  }
});

/**
 * GET /health
 * Health check endpoint
 */
app.get('/health', (req, res) => {
  const stats = jobManager.getStats();
  const workerStatus = worker ? worker.getStatus() : { running: false };

  res.json({
    status: 'ok',
    service: 'Twitter Video Generator API',
    version: '1.0.0',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    environment: NODE_ENV,
    worker: {
      running: workerStatus.running,
      currentJobs: workerStatus.currentJobs || 0,
      maxConcurrentJobs: workerStatus.maxConcurrentJobs || 0,
    },
    jobs: {
      total: stats.total,
      pending: stats.pending,
      processing: stats.processing,
      completed: stats.completed,
      failed: stats.failed,
    },
  });
});

// ============================================================================
// Middleware Functions
// ============================================================================

/**
 * Validates video generation request body
 */
function validateVideoRequest(req, res, next) {
  const { tweetBody, profilePhotoUrl, profileName, username, theme } = req.body;

  // Required fields
  if (!tweetBody || typeof tweetBody !== 'string') {
    return res.status(400).json({
      error: 'Bad Request',
      message: 'tweetBody is required and must be a string',
      timestamp: new Date().toISOString(),
    });
  }

  if (!profilePhotoUrl || typeof profilePhotoUrl !== 'string') {
    return res.status(400).json({
      error: 'Bad Request',
      message: 'profilePhotoUrl is required and must be a string',
      timestamp: new Date().toISOString(),
    });
  }

  if (!profileName || typeof profileName !== 'string') {
    return res.status(400).json({
      error: 'Bad Request',
      message: 'profileName is required and must be a string',
      timestamp: new Date().toISOString(),
    });
  }

  if (!username || typeof username !== 'string') {
    return res.status(400).json({
      error: 'Bad Request',
      message: 'username is required and must be a string',
      timestamp: new Date().toISOString(),
    });
  }

  // Length limits
  if (tweetBody.length > 5000) {
    return res.status(400).json({
      error: 'Bad Request',
      message: 'tweetBody exceeds maximum length of 5000 characters',
      timestamp: new Date().toISOString(),
    });
  }

  if (profileName.length > 100) {
    return res.status(400).json({
      error: 'Bad Request',
      message: 'profileName exceeds maximum length of 100 characters',
      timestamp: new Date().toISOString(),
    });
  }

  // Theme validation
  if (theme && !['dark', 'light'].includes(theme)) {
    return res.status(400).json({
      error: 'Bad Request',
      message: 'theme must be either "dark" or "light"',
      timestamp: new Date().toISOString(),
    });
  }

  // URL validation (basic)
  try {
    new URL(profilePhotoUrl);
  } catch (error) {
    return res.status(400).json({
      error: 'Bad Request',
      message: 'profilePhotoUrl must be a valid URL',
      timestamp: new Date().toISOString(),
    });
  }

  next();
}

/**
 * Helper function to get progress message
 */
function getProgressMessage(step) {
  const messages = {
    'generating_screenshot': 'Rendering tweet screenshot...',
    'composing_video': 'Composing video with effects...',
    'saving_file': 'Saving video file...',
  };
  return messages[step] || 'Processing...';
}

// ============================================================================
// Error Handling
// ============================================================================

/**
 * 404 handler
 */
app.use((req, res) => {
  res.status(404).json({
    error: 'Not Found',
    message: `Route ${req.method} ${req.path} not found`,
    timestamp: new Date().toISOString(),
  });
});

/**
 * Global error handler
 */
app.use((err, req, res, next) => {
  console.error('[Server] Unhandled error:', err);

  res.status(500).json({
    error: 'Internal Server Error',
    message: NODE_ENV === 'development' ? err.message : 'An unexpected error occurred',
    timestamp: new Date().toISOString(),
  });
});

// ============================================================================
// Server Lifecycle
// ============================================================================

/**
 * Graceful shutdown handler
 */
async function gracefulShutdown(signal) {
  console.log(`\n[Server] ${signal} received, starting graceful shutdown...`);

  // Stop accepting new requests
  if (server) {
    server.close(() => {
      console.log('[Server] HTTP server closed');
    });
  }

  // Stop worker and cleanup scheduler
  if (worker) {
    console.log('[Server] Stopping background worker...');
    await worker.stop();
    console.log('[Server] ✓ Background worker stopped');
  }

  if (cleanupScheduler) {
    console.log('[Server] Stopping cleanup scheduler...');
    cleanupScheduler.stop();
    console.log('[Server] ✓ Cleanup scheduler stopped');
  }

  console.log('[Server] Graceful shutdown completed');
  process.exit(0);
}

// Register shutdown handlers
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

/**
 * Start the server
 */
async function startServer() {
  try {
    // Initialize components
    await initializeComponents();

    // Start HTTP server
    server = app.listen(PORT, () => {
      console.log('\n' + '='.repeat(60));
      console.log('🚀 Twitter Video Generator API');
      console.log('='.repeat(60));
      console.log(`Environment:     ${NODE_ENV}`);
      console.log(`Server URL:      ${BASE_URL}`);
      console.log(`Port:            ${PORT}`);
      console.log(`Template:        ${TEMPLATE_PATH}`);
      console.log(`Audio:           ${AUDIO_PATH}`);
      console.log(`Storage:         ${process.env.STORAGE_PATH || '/data/videos'}`);
      console.log('='.repeat(60));
      console.log('\n✅ Server ready to accept requests');
      console.log(`📖 API Documentation: ${BASE_URL}/health\n`);
    });

    server.on('error', (error) => {
      if (error.code === 'EADDRINUSE') {
        console.error(`[Server] Error: Port ${PORT} is already in use`);
      } else {
        console.error('[Server] Server error:', error);
      }
      process.exit(1);
    });
  } catch (error) {
    console.error('[Server] Failed to start server:', error);
    process.exit(1);
  }
}

// Start the server
if (require.main === module) {
  startServer();
}

// Export for testing
module.exports = { app, startServer, gracefulShutdown };
