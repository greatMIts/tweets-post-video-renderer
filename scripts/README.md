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
node scripts/test-remote.js <URL>

# Examples:
node scripts/test-remote.js https://my-api.railway.app
node scripts/test-remote.js my-api.railway.app
```

### validate.js - Validate Setup
```bash
node scripts/validate.js
```

## Output Files
- `test-output.mp4` - Local test video
- `test-output-remote.mp4` - Remote test video

See main README.md for full documentation.
