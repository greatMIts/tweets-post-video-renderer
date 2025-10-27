const ffmpeg = require('fluent-ffmpeg');
const { FFmpegDetector } = require('./ffmpeg-detector.js');

/**
 * VideoComposer - Production-ready video composition utility using FFmpeg
 * Combines screenshots with audio to create video reels with fade effects
 */
class VideoComposer {
  constructor() {
    this.ffmpegPath = null;
    this.initialized = false;
  }

  /**
   * Initialize the video composer by detecting and setting FFmpeg path
   * @returns {Promise<void>}
   * @throws {Error} If FFmpeg is not found on the system
   */
  async initialize() {
    if (this.initialized) {
      console.log('[VideoComposer] Already initialized');
      return;
    }

    try {
      console.log('[VideoComposer] Initializing video composer...');

      // Detect FFmpeg installation
      this.ffmpegPath = await FFmpegDetector.detectOrThrow();

      // Set FFmpeg path for fluent-ffmpeg
      ffmpeg.setFfmpegPath(this.ffmpegPath);

      this.initialized = true;
      console.log('[VideoComposer] Video composer initialized successfully');
    } catch (error) {
      console.error('[VideoComposer] Initialization failed:', error.message);
      throw new Error(`VideoComposer initialization failed: ${error.message}`);
    }
  }

  /**
   * Compose a video from a screenshot and audio file
   * @param {string} screenshotPath - Path to the screenshot image
   * @param {string} audioPath - Path to the audio file
   * @param {string} outputPath - Path for the output video file
   * @param {Object} options - Composition options
   * @param {number} [options.duration=5] - Video duration in seconds
   * @param {number} [options.width=1080] - Video width in pixels
   * @param {number} [options.height=1920] - Video height in pixels
   * @param {number} [options.fps=30] - Frames per second
   * @param {number} [options.fadeInDuration=0.5] - Fade in duration in seconds
   * @param {number} [options.fadeOutDuration=0.5] - Fade out duration in seconds
   * @param {number} [options.audioVolume=0.3] - Audio volume (0.0 to 1.0)
   * @returns {Promise<string>} Resolves with outputPath on success
   * @throws {Error} If composition fails
   */
  async compose(screenshotPath, audioPath, outputPath, options = {}) {
    if (!this.initialized) {
      throw new Error('VideoComposer not initialized. Call initialize() first.');
    }

    // Validate required parameters
    if (!screenshotPath || typeof screenshotPath !== 'string') {
      throw new Error('Invalid screenshotPath: must be a non-empty string');
    }
    if (!audioPath || typeof audioPath !== 'string') {
      throw new Error('Invalid audioPath: must be a non-empty string');
    }
    if (!outputPath || typeof outputPath !== 'string') {
      throw new Error('Invalid outputPath: must be a non-empty string');
    }

    // Set default options
    const config = {
      duration: options.duration ?? 5,
      width: options.width ?? 1080,
      height: options.height ?? 1920,
      fps: options.fps ?? 30,
      fadeInDuration: options.fadeInDuration ?? 0.5,
      fadeOutDuration: options.fadeOutDuration ?? 0.5,
      audioVolume: options.audioVolume ?? 0.3
    };

    // Validate numeric options
    this._validateNumericOptions(config);

    console.log('[VideoComposer] Starting video composition...');
    console.log('[VideoComposer] Configuration:', {
      screenshot: screenshotPath,
      audio: audioPath,
      output: outputPath,
      ...config
    });

    return new Promise((resolve, reject) => {
      try {
        // Calculate fade timings
        const fadeOutStart = config.duration - config.fadeOutDuration;

        // Build complex filter for video and audio processing
        const videoFilter = this._buildVideoFilter(config, fadeOutStart);
        const audioFilter = this._buildAudioFilter(config, fadeOutStart);
        const complexFilter = `${videoFilter};${audioFilter}`;

        console.log('[VideoComposer] FFmpeg complex filter:', complexFilter);

        // Create FFmpeg command
        const command = ffmpeg()
          // Input 1: Screenshot (loop mode)
          .input(screenshotPath)
          .inputOptions([
            '-loop 1',
            '-framerate', config.fps.toString()
          ])
          // Input 2: Audio file
          .input(audioPath)
          // Complex filter chain
          .complexFilter(complexFilter, ['video_out', 'audio_out'])
          // Video codec settings
          .videoCodec('libx264')
          .outputOptions([
            '-preset medium',
            '-crf 23',
            '-pix_fmt yuv420p'
          ])
          // Audio codec settings
          .audioCodec('aac')
          .audioBitrate('128k')
          // Output duration
          .duration(config.duration)
          // Optimize for streaming (move moov atom to beginning)
          .outputOptions('-movflags +faststart')
          // Output file
          .output(outputPath);

        // Log the full FFmpeg command
        command.on('start', (commandLine) => {
          console.log('[VideoComposer] Executing FFmpeg command:', commandLine);
        });

        // Track progress
        command.on('progress', (progress) => {
          const percent = progress.percent ? progress.percent.toFixed(2) : '0.00';
          const timemark = progress.timemark || '00:00:00.00';
          console.log(`[VideoComposer] Progress: ${percent}% (${timemark})`);
        });

        // Handle errors
        command.on('error', (error, stdout, stderr) => {
          console.error('[VideoComposer] FFmpeg error:', error.message);
          if (stderr) {
            console.error('[VideoComposer] FFmpeg stderr:', stderr);
          }
          reject(new Error(`Video composition failed: ${error.message}`));
        });

        // Handle completion
        command.on('end', (stdout, stderr) => {
          console.log('[VideoComposer] Video composition completed successfully');
          console.log('[VideoComposer] Output file:', outputPath);
          resolve(outputPath);
        });

        // Run the command
        command.run();

      } catch (error) {
        console.error('[VideoComposer] Composition setup failed:', error.message);
        reject(new Error(`Failed to setup video composition: ${error.message}`));
      }
    });
  }

  /**
   * Build the video filter chain
   * @private
   * @param {Object} config - Configuration object
   * @param {number} fadeOutStart - When to start fade out
   * @returns {string} Video filter string
   */
  _buildVideoFilter(config, fadeOutStart) {
    // Video processing chain:
    // 1. Scale to target dimensions
    // 2. Set sample aspect ratio to 1:1
    // 3. Convert to YUV420P pixel format
    // 4. Apply fade in effect
    // 5. Apply fade out effect
    return [
      `[0:v]scale=${config.width}:${config.height}:force_original_aspect_ratio=decrease`,
      `pad=${config.width}:${config.height}:(ow-iw)/2:(oh-ih)/2:black`,
      'setsar=1',
      'format=yuv420p',
      `fade=t=in:st=0:d=${config.fadeInDuration}`,
      `fade=t=out:st=${fadeOutStart}:d=${config.fadeOutDuration}[video_out]`
    ].join(',');
  }

  /**
   * Build the audio filter chain
   * @private
   * @param {Object} config - Configuration object
   * @param {number} fadeOutStart - When to start fade out
   * @returns {string} Audio filter string
   */
  _buildAudioFilter(config, fadeOutStart) {
    // Audio processing chain:
    // 1. Apply fade in effect
    // 2. Apply fade out effect
    // 3. Adjust volume
    return [
      `[1:a]afade=t=in:st=0:d=${config.fadeInDuration}`,
      `afade=t=out:st=${fadeOutStart}:d=${config.fadeOutDuration}`,
      `volume=${config.audioVolume}[audio_out]`
    ].join(',');
  }

  /**
   * Validate numeric options
   * @private
   * @param {Object} config - Configuration object to validate
   * @throws {Error} If any option is invalid
   */
  _validateNumericOptions(config) {
    const validations = [
      { name: 'duration', value: config.duration, min: 0.1, max: 3600 },
      { name: 'width', value: config.width, min: 1, max: 7680, integer: true },
      { name: 'height', value: config.height, min: 1, max: 4320, integer: true },
      { name: 'fps', value: config.fps, min: 1, max: 120, integer: true },
      { name: 'fadeInDuration', value: config.fadeInDuration, min: 0, max: config.duration },
      { name: 'fadeOutDuration', value: config.fadeOutDuration, min: 0, max: config.duration },
      { name: 'audioVolume', value: config.audioVolume, min: 0, max: 2 }
    ];

    for (const validation of validations) {
      const { name, value, min, max, integer } = validation;

      if (typeof value !== 'number' || isNaN(value)) {
        throw new Error(`Invalid ${name}: must be a number`);
      }

      if (integer && !Number.isInteger(value)) {
        throw new Error(`Invalid ${name}: must be an integer`);
      }

      if (value < min || value > max) {
        throw new Error(`Invalid ${name}: must be between ${min} and ${max}`);
      }
    }

    // Validate that fade durations don't exceed video duration
    if (config.fadeInDuration + config.fadeOutDuration > config.duration) {
      throw new Error(
        `Fade durations (in: ${config.fadeInDuration}s + out: ${config.fadeOutDuration}s) ` +
        `exceed video duration (${config.duration}s)`
      );
    }
  }

  /**
   * Check if the composer is initialized
   * @returns {boolean}
   */
  isInitialized() {
    return this.initialized;
  }

  /**
   * Get the detected FFmpeg path
   * @returns {string|null}
   */
  getFFmpegPath() {
    return this.ffmpegPath;
  }
}

module.exports = { VideoComposer };
