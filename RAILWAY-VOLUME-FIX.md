# Railway Volume Permission Fix

## Issue

Getting `EACCES: permission denied` when trying to write to `/data/videos` on Railway.

## Root Cause

Railway volumes are mounted with specific permissions that may not match the container's user. The Node.js process runs as the `node` user (non-root) but the volume might have different ownership.

## Solution Applied

The server now automatically:

1. **Tests write permissions** on startup
2. **Falls back to /tmp** if `/data/videos` is not writable
3. **Logs the active storage path** so you can verify in Railway logs

## Deployment Steps for Railway

### Option 1: Use /tmp (Temporary Storage) ✅ Recommended for Testing

No volume needed! The app will automatically use `/tmp/videos`.

**Pros:**
- Works immediately
- No configuration needed
- Good for testing

**Cons:**
- Files lost on restart
- Limited by container disk space

**Setup:**
```bash
# No special setup required!
# Just deploy and it will use /tmp automatically
git push
```

### Option 2: Use Persistent Volume (Production)

For production where you want files to persist across restarts:

#### Step 1: Remove the Volume (if exists)
1. Go to Railway dashboard → Your service
2. Click "Volumes" tab
3. Delete existing volume if there's one

#### Step 2: Create New Volume with Correct Path
1. Click "New Volume"
2. Set **Mount Path:** `/data`
3. Set **Size:** 10GB or more
4. Click "Add"

#### Step 3: Update Environment Variables
```env
STORAGE_PATH=/data/videos
```

#### Step 4: Redeploy
```bash
git commit --allow-empty -m "Trigger redeploy"
git push
```

#### Step 5: Verify in Logs
Check Railway logs for:
```
✓ Storage directory verified: /data/videos
```

If you see:
```
⚠️  Storage directory check failed
✓ Using fallback storage: /tmp/videos
```

This means the volume permissions are still wrong.

### Option 3: Run as Root (Not Recommended)

If you absolutely need `/data/videos` and the above doesn't work:

**Edit Dockerfile:**
```dockerfile
# Comment out or remove this line:
# USER node

# The container will run as root
```

**WARNING:** Running as root is a security risk. Only use for debugging.

## Verifying Storage

After deployment, check the logs:

```bash
railway logs
```

Look for:
```
[Server] Initializing components...
[Server] ✓ Storage directory verified: /data/videos
[Server] ✓ Storage provider initialized
```

Or if using fallback:
```
[Server] ⚠️  Storage directory check failed: EACCES: permission denied
[Server] Permission denied. Using fallback directory...
[Server] ✓ Using fallback storage: /tmp/videos
```

## Testing After Fix

```bash
# Test the remote instance
node scripts/test-remote.js https://your-app.railway.app

# Should complete successfully and download video
```

## Current Behavior

With the latest update:

1. **Tries `/data/videos` first** (if STORAGE_PATH is set)
2. **Tests write access** with a temporary file
3. **Falls back to `/tmp/videos`** if permission denied
4. **Continues working** regardless of volume configuration

This means your app will work on Railway even without a volume, but files will be temporary.

## Production Recommendation

For production:
- ✅ Use a properly configured Railway volume at `/data`
- ✅ Set STORAGE_TTL_HOURS to a reasonable value (24-72 hours)
- ✅ Monitor disk usage
- ✅ Consider upgrading to cloud storage (S3/GCS) for scalability

For testing/demo:
- ✅ Use the automatic /tmp fallback
- ✅ No volume configuration needed
- ✅ Quick deploys

## Troubleshooting

### Still getting permission errors?

1. **Check Railway logs:** `railway logs`
2. **Verify the fallback is working:** Look for "Using fallback storage: /tmp/videos"
3. **Check environment variables:** Make sure STORAGE_PATH isn't overriding
4. **Try removing STORAGE_PATH:** Let it use defaults

### Volume shows mounted but still fails?

Railway mounts volumes AFTER the container starts, so:
1. The volume overwrites our Dockerfile permissions
2. The `node` user may not have write access to the mounted volume
3. The fallback to `/tmp` is the safest solution

### Want to force /tmp?

Set this in Railway environment variables:
```env
STORAGE_PATH=/tmp/videos
```

This will skip the `/data/videos` attempt entirely.

## Files Updated

- ✅ `server.js` - Added storage directory verification and fallback
- ✅ `Dockerfile` - Proper permissions for both /data and /app
- ✅ This guide for Railway-specific deployment

## Summary

**The app now works on Railway regardless of volume configuration!**

- If `/data/videos` is writable → Uses it ✅
- If `/data/videos` has permission issues → Falls back to `/tmp/videos` ✅
- Either way, your app keeps running 🚀

Deploy and test:
```bash
git add .
git commit -m "Fix Railway volume permissions"
git push
railway logs -f
```
