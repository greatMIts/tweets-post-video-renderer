# Scripts Directory - Quick Reference

Test scripts for the Twitter Video Generator API.

## Scripts

### test-local.js - Test Local Server
```bash
npm test
# or
node scripts/test-local.js
```

### test-remote.js - Test Remote Server
```bash
# Basic usage (sample data)
node scripts/test-remote.js <URL>

# Interactive mode (custom data)
node scripts/test-remote.js <URL> --interactive
node scripts/test-remote.js <URL> -i

# Examples:
node scripts/test-remote.js https://my-api.railway.app
node scripts/test-remote.js my-api.railway.app -i
```

### validate.js - Validate Setup
```bash
node scripts/validate.js
```

## Output Files
- `test-output.mp4` - Local test video
- `test-output-remote.mp4` - Remote test video

See main README.md for full documentation.
