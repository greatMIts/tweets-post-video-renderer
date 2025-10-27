#!/usr/bin/env node

/**
 * Remote Testing Script for Video Generation API
 *
 * This script tests the video generation API on a remote server by:
 * 1. Creating a signed request to generate a video
 * 2. Polling for job completion
 * 3. Downloading the generated video
 *
 * Usage:
 *   node scripts/test-remote.js <API_URL>
 *   node scripts/test-remote.js https://your-app.railway.app
 *
 * The HMAC_SECRET must be set in your .env file and match the remote server.
 */

const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// Get URL from command line argument
const REMOTE_URL = process.argv[2];

// Configuration
const HMAC_SECRET = process.env.HMAC_SECRET;
const POLL_INTERVAL_MS = 5000; // 5 seconds
const MAX_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const OUTPUT_FILE = path.join(__dirname, '..', 'test-output-remote.mp4');

// ANSI color codes for better output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m'
};

// Logging utilities
function log(message, color = colors.reset) {
  console.log(`${color}${message}${colors.reset}`);
}

function logStep(step, message) {
  log(`\n${colors.bright}[${step}]${colors.reset} ${message}`);
}

function logInfo(message) {
  log(`${colors.blue}ℹ${colors.reset} ${message}`);
}

function logSuccess(message) {
  log(`${colors.green}✓${colors.reset} ${message}`, colors.green);
}

function logError(message) {
  log(`${colors.red}✗${colors.reset} ${message}`, colors.red);
}

function logWarning(message) {
  log(`${colors.yellow}⚠${colors.reset} ${message}`, colors.yellow);
}

function logProgress(message, percentage) {
  const barLength = 30;
  const filledLength = Math.round((barLength * percentage) / 100);
  const bar = '█'.repeat(filledLength) + '░'.repeat(barLength - filledLength);
  process.stdout.write(`\r${colors.cyan}${bar}${colors.reset} ${percentage}% - ${message}`);
  if (percentage >= 100) {
    process.stdout.write('\n');
  }
}

/**
 * Validates and normalizes the URL
 *
 * @param {string} url - URL to validate
 * @returns {string} Normalized URL
 */
function validateUrl(url) {
  if (!url) {
    throw new Error('URL is required');
  }

  // Remove trailing slash
  url = url.replace(/\/$/, '');

  // Ensure it starts with http:// or https://
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'https://' + url;
  }

  // Validate URL format
  try {
    new URL(url);
    return url;
  } catch (error) {
    throw new Error(`Invalid URL format: ${url}`);
  }
}

/**
 * Generates an HMAC-SHA256 signature for request authentication
 *
 * @param {number} timestamp - Unix timestamp in seconds
 * @param {Object} body - Request body object
 * @returns {string} Hex-encoded HMAC signature
 */
function generateSignature(timestamp, body) {
  if (!HMAC_SECRET) {
    throw new Error('HMAC_SECRET environment variable is not set');
  }

  const timestampStr = String(timestamp);
  const bodyStr = JSON.stringify(body);
  const message = `${timestampStr}:${bodyStr}`;

  const hmac = crypto.createHmac('sha256', HMAC_SECRET);
  hmac.update(message);

  return hmac.digest('hex');
}

/**
 * Makes an authenticated request to the API
 *
 * @param {string} method - HTTP method
 * @param {string} endpoint - API endpoint
 * @param {Object} body - Request body (optional)
 * @returns {Promise<Object>} Response data
 */
async function makeAuthenticatedRequest(method, endpoint, body = null) {
  const timestamp = Math.floor(Date.now() / 1000);
  const url = `${REMOTE_URL}${endpoint}`;

  const config = {
    method,
    url,
    headers: {
      'Content-Type': 'application/json',
      'X-Timestamp': timestamp.toString()
    },
    timeout: 30000 // 30 second timeout
  };

  if (body) {
    config.data = body;
    const signature = generateSignature(timestamp, body);
    config.headers['X-Signature'] = signature;
  }

  try {
    const response = await axios(config);
    return response.data;
  } catch (error) {
    if (error.response) {
      // Server responded with error status
      throw new Error(
        `API Error (${error.response.status}): ${error.response.data.message || error.response.data.error || 'Unknown error'}`
      );
    } else if (error.request) {
      // Request made but no response
      throw new Error('Network Error: No response from server. Is the API accessible?');
    } else {
      // Error setting up request
      throw new Error(`Request Error: ${error.message}`);
    }
  }
}

/**
 * Polls a job until it completes or fails
 *
 * @param {string} jobId - Job ID to poll
 * @returns {Promise<Object>} Final job status
 */
async function pollJobStatus(jobId) {
  const startTime = Date.now();
  let lastStatus = null;
  let lastProgress = 0;

  while (true) {
    // Check timeout
    if (Date.now() - startTime > MAX_TIMEOUT_MS) {
      throw new Error('Timeout: Job did not complete within 5 minutes');
    }

    // Get job status
    const job = await makeAuthenticatedRequest('GET', `/job/${jobId}`);

    // Show progress if changed
    if (job.status !== lastStatus || job.progress !== lastProgress) {
      if (job.status === 'processing' && job.currentStep) {
        logProgress(job.currentStep, job.progress || 0);
      } else if (job.status === 'pending') {
        logInfo('Job is pending...');
      }
      lastStatus = job.status;
      lastProgress = job.progress;
    }

    // Check if job is complete
    if (job.status === 'completed') {
      return job;
    }

    // Check if job failed
    if (job.status === 'failed') {
      throw new Error(`Job failed: ${job.error || 'Unknown error'}`);
    }

    // Wait before next poll
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

/**
 * Downloads a file from a URL
 *
 * @param {string} url - URL to download from
 * @param {string} outputPath - Path to save the file
 * @returns {Promise<number>} File size in bytes
 */
async function downloadFile(url, outputPath) {
  const response = await axios({
    method: 'GET',
    url,
    responseType: 'stream',
    timeout: 60000 // 60 second timeout for download
  });

  const writer = fs.createWriteStream(outputPath);
  response.data.pipe(writer);

  return new Promise((resolve, reject) => {
    let downloadedBytes = 0;
    const totalBytes = parseInt(response.headers['content-length'], 10);

    response.data.on('data', (chunk) => {
      downloadedBytes += chunk.length;
      if (totalBytes) {
        const percentage = Math.round((downloadedBytes / totalBytes) * 100);
        logProgress('Downloading video', percentage);
      }
    });

    writer.on('finish', () => {
      const stats = fs.statSync(outputPath);
      resolve(stats.size);
    });

    writer.on('error', reject);
    response.data.on('error', reject);
  });
}

/**
 * Formats bytes to human-readable format
 *
 * @param {number} bytes - Bytes to format
 * @returns {string} Formatted string
 */
function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

/**
 * Tests the health endpoint
 *
 * @returns {Promise<Object>} Health check response
 */
async function testHealthEndpoint() {
  try {
    const response = await axios.get(`${REMOTE_URL}/health`, { timeout: 10000 });
    return response.data;
  } catch (error) {
    if (error.response) {
      throw new Error(`Health check failed with status ${error.response.status}`);
    } else if (error.code === 'ECONNREFUSED') {
      throw new Error('Connection refused. Is the server running?');
    } else if (error.code === 'ETIMEDOUT') {
      throw new Error('Connection timeout. Server may be down or unreachable.');
    } else {
      throw new Error(`Health check failed: ${error.message}`);
    }
  }
}

/**
 * Main test function
 */
async function testVideoGeneration() {
  const testStartTime = Date.now();

  // Print header
  log('\n' + '='.repeat(60), colors.cyan);
  log('  Video Generation API - Remote Server Test', colors.bright);
  log('='.repeat(60) + '\n', colors.cyan);

  try {
    // Validate URL argument
    if (!REMOTE_URL) {
      log('\n' + colors.red + 'Error: No URL provided' + colors.reset + '\n');
      log('Usage:');
      log('  node scripts/test-remote.js <API_URL>');
      log('  node scripts/test-remote.js https://your-app.railway.app\n');
      log('Examples:');
      log('  node scripts/test-remote.js https://my-api.railway.app');
      log('  node scripts/test-remote.js http://localhost:3000');
      log('  node scripts/test-remote.js my-api.railway.app  ' + colors.dim + '(will add https://)' + colors.reset);
      log('');
      process.exit(1);
    }

    // Validate configuration
    logStep('1/6', 'Validating configuration');

    const baseUrl = validateUrl(REMOTE_URL);
    logSuccess(`Remote URL: ${baseUrl}`);

    if (!HMAC_SECRET) {
      throw new Error('HMAC_SECRET not found in environment variables. Please create a .env file.');
    }

    logInfo(`HMAC Secret: ${HMAC_SECRET.substring(0, 10)}...`);
    logSuccess('Configuration valid\n');

    // Test health endpoint
    logStep('2/6', 'Testing /health endpoint');

    const health = await testHealthEndpoint();
    logSuccess('Server is healthy');
    logInfo(`Service: ${health.service}`);
    logInfo(`Version: ${health.version}`);
    logInfo(`Uptime: ${Math.round(health.uptime)}s`);
    logInfo(`Worker: ${health.worker.running ? 'Running' : 'Stopped'} (${health.worker.currentJobs}/${health.worker.maxConcurrentJobs} jobs)`);
    logInfo(`Jobs: ${health.jobs.pending} pending, ${health.jobs.processing} processing, ${health.jobs.completed} completed, ${health.jobs.failed} failed\n`);

    // Create request body with sample tweet data
    logStep('3/6', 'Creating video generation request');

    const requestBody = {
      theme: 'dark',
      profilePhotoUrl: 'https://pbs.twimg.com/profile_images/1590968738358079488/IY9Gx6Ok_400x400.jpg',
      profileName: 'Claude Code',
      username: 'anthropic',
      tweetBody: `Testing the video generation API on remote server!\n\nURL: ${baseUrl}\n\nThe deployment is working great! 🚀`
    };

    logInfo('Sample tweet data:');
    logInfo(`  Theme: ${requestBody.theme}`);
    logInfo(`  Profile: ${requestBody.profileName} (@${requestBody.username})`);
    logInfo(`  Tweet: "${requestBody.tweetBody.substring(0, 50)}..."`);

    // Submit video generation request
    logStep('4/6', 'Submitting request to /generate-video');

    const createResponse = await makeAuthenticatedRequest(
      'POST',
      '/generate-video',
      requestBody
    );

    logSuccess(`Job created: ${createResponse.jobId}`);
    logInfo(`Status: ${createResponse.status}`);
    logInfo(`Estimated time: ${createResponse.estimatedCompletionTime || '30-60s'}`);

    // Poll for completion
    logStep('5/6', 'Polling job status');

    const completedJob = await pollJobStatus(createResponse.jobId);

    logSuccess('Job completed successfully!');
    logInfo(`Download URL: ${completedJob.downloadUrl}`);
    logInfo(`File Size: ${formatBytes(completedJob.fileSize)}`);
    logInfo(`Duration: ${completedJob.duration}s`);
    logInfo(`Resolution: ${completedJob.resolution}`);
    logInfo(`Expires At: ${new Date(completedJob.expiresAt).toLocaleString()}`);

    // Download video
    logStep('6/6', 'Downloading video');

    logInfo(`Saving to: ${OUTPUT_FILE}`);

    const fileSize = await downloadFile(completedJob.downloadUrl, OUTPUT_FILE);

    logSuccess(`Video downloaded successfully!`);
    logInfo(`File size: ${formatBytes(fileSize)}`);
    logInfo(`Location: ${OUTPUT_FILE}`);

    // Print summary
    const totalTime = ((Date.now() - testStartTime) / 1000).toFixed(2);

    log('\n' + '='.repeat(60), colors.green);
    log('  Remote Test Completed Successfully!', colors.bright);
    log('='.repeat(60), colors.green);
    log(`\n${colors.green}Remote URL: ${baseUrl}${colors.reset}`);
    log(`${colors.green}Total time: ${totalTime}s${colors.reset}`);
    log(`${colors.green}Output file: ${OUTPUT_FILE}${colors.reset}\n`);

    process.exit(0);

  } catch (error) {
    // Print error
    log('\n' + '='.repeat(60), colors.red);
    log('  Remote Test Failed', colors.bright);
    log('='.repeat(60), colors.red);
    logError(`\n${error.message}\n`);

    // Provide helpful debugging info
    if (error.message.includes('Network Error') || error.message.includes('ECONNREFUSED')) {
      logWarning('Troubleshooting tips:');
      log('  • Verify the URL is correct and accessible');
      log('  • Check if the server is running');
      log('  • Try accessing the /health endpoint in a browser');
      log(`  • URL: ${REMOTE_URL}/health\n`);
    } else if (error.message.includes('401') || error.message.includes('HMAC')) {
      logWarning('Authentication tips:');
      log('  • Verify HMAC_SECRET matches the remote server');
      log('  • Check that the secret is set in Railway environment variables');
      log('  • Ensure your local .env has the correct secret\n');
    } else if (error.message.includes('Timeout')) {
      logWarning('Timeout tips:');
      log('  • Video generation may take up to 5 minutes');
      log('  • Check server logs for errors');
      log('  • Verify the worker is running on the remote server\n');
    }

    if (error.stack && process.env.NODE_ENV === 'development') {
      log(colors.dim + error.stack + colors.reset);
    }

    log('');
    process.exit(1);
  }
}

// Run the test
if (require.main === module) {
  testVideoGeneration();
}

module.exports = { testVideoGeneration, generateSignature, makeAuthenticatedRequest };
