# CI/CD Setup for Dyad

This document explains the Continuous Integration and Continuous Deployment (CI/CD) setup for the Dyad Electron app.

## 🛠️ Overview

Our CI/CD pipeline consists of several GitHub Actions workflows that handle different aspects of the development lifecycle:

1. **Continuous Integration** (`ci.yml`) - Existing comprehensive testing
2. **Build & Release** (`build-release.yml`) - Build and release app binaries
3. **Nightly Builds** (`nightly.yml`) - Automated daily development builds
4. **Other workflows** - Issue triage, duplicate detection, etc.

## 📎 Workflow Details

### 1. Continuous Integration (`ci.yml`)
**Triggers:** Push to main, Pull Requests
**Purpose:** Comprehensive testing with E2E tests

- Runs on macOS and Windows with multiple shards
- Performs linting, type-checking, and unit tests
- Executes E2E tests using Playwright
- Generates merged HTML reports
- Uses pnpm for template dependencies

### 2. Build & Release (`build-release.yml`)
**Triggers:** 
- Push to main branch
- Git tags (`v*`)
- Pull requests (quick build check only)
- Manual dispatch

**Features:**
- ✅ **Multi-platform builds**: macOS (Universal + Intel), Windows, Linux
- ✅ **Comprehensive testing**: Type checks, linting, unit tests
- ✅ **Artifact management**: Uploads build artifacts for 30 days
- ✅ **Smart releases**: Draft/prerelease/release based on trigger
- ✅ **PR build checks**: Fast feedback for pull requests

**Build Matrix:**
| Platform | OS | Architecture | Output |
|----------|----|--------------|---------|
| macOS | `macos-latest` | Universal | `.dmg`, `.zip` |
| macOS Intel | `macos-13` | x64 | `.dmg`, `.zip` |
| Windows | `windows-latest` | x64 | `.exe`, `.nupkg`, `.zip` |
| Linux | `ubuntu-22.04` | x64 | `.deb`, `.rpm`, `.zip` |

### 3. Nightly Builds (`nightly.yml`)
**Triggers:** 
- Daily at 2 AM UTC
- Manual dispatch

**Features:**
- ✅ **Smart change detection**: Only builds if commits in last 24h
- ✅ **Version management**: Automatic nightly versioning
- ✅ **Cleanup**: Keeps only last 7 nightly releases
- ✅ **Development focused**: Marked as prerelease

**Nightly Version Format:** `{version}-nightly.{YYYYMMDD}.{short-sha}`

## 🚀 Usage Guide

### For Developers

#### Running CI Locally
```bash
# Run the same checks as CI
npm run ts          # Type checking
npm run lint        # Linting
npm test           # Unit tests
npm run presubmit  # All checks
```

#### Testing Build Locally
```bash
# Package the app (no installer)
npm run package

# Build installers (full build)
npm run make
```

### Creating Releases

#### 1. Automatic Release (Recommended)
```bash
# Create and push a version tag
git tag v1.0.0
git push origin v1.0.0
```
This triggers the build workflow and creates a release automatically.

#### 2. Manual Release
1. Go to **Actions** tab in GitHub
2. Select **"Build and Release Electron App"**
3. Click **"Run workflow"**
4. Choose release type: Draft, Prerelease, or Release

#### 3. Version Naming Convention
- **Stable release**: `v1.2.3`
- **Beta release**: `v1.2.3-beta.1` (automatically marked as prerelease)
- **Alpha release**: `v1.2.3-alpha.1` (automatically marked as prerelease)
- **Release candidate**: `v1.2.3-rc.1` (automatically marked as prerelease)

### Getting Nightly Builds

1. Go to **Releases** section
2. Look for releases tagged `nightly-YYYY-MM-DD-{sha}`
3. Download the appropriate file for your OS

**⚠️ Warning**: Nightly builds are for testing only and may be unstable.

## 📁 Artifacts & Downloads

### Release Artifacts
Each successful build produces the following artifacts:

**macOS:**
- `dyad-{version}.dmg` - Disk image installer
- `dyad-darwin-{arch}-{version}.zip` - Portable app

**Windows:**
- `dyad-{version}.Setup.exe` - Installer
- `dyad-{version}-full.nupkg` - Update package
- `dyad-win32-{arch}-{version}.zip` - Portable app

**Linux:**
- `dyad_{version}_amd64.deb` - Debian package
- `dyad-{version}-1.x86_64.rpm` - RPM package
- `dyad-linux-{arch}-{version}.zip` - Portable app

### Artifact Retention
- **Regular builds**: 30 days
- **PR builds**: 7 days  
- **Nightly builds**: 14 days
- **Releases**: Permanent (until manually deleted)

## 🔧 Configuration

### Environment Variables
- `NODE_VERSION`: Node.js version (currently 20)
- `NODE_OPTIONS`: Node.js memory settings (`--max-old-space-size=4096`)
- `NODE_ENV`: Set to `production` for builds

### Required Secrets
None required for basic building. The workflows use:
- `GITHUB_TOKEN` - Automatically provided by GitHub Actions

### Platform-Specific Dependencies

**Linux:**
```bash
sudo apt-get install -y libnss3-dev libatk-bridge2.0-dev libdrm2 libxkbcommon0 libxss1 libasound2-dev
```

**macOS & Windows:**
No additional system dependencies required.

## 📊 Monitoring & Troubleshooting

### Build Status
- Check the **Actions** tab for workflow runs
- Each workflow shows detailed logs for debugging
- Failed builds will show error messages in the logs

### Common Issues

1. **Build fails on specific OS**
   - Check OS-specific dependencies
   - Look at the detailed logs for that platform

2. **Out of memory errors**
   - Increase `NODE_OPTIONS` memory limit
   - Consider splitting large builds

3. **Artifact upload fails**
   - Check file paths in workflow
   - Verify files are actually generated

4. **Release creation fails**
   - Check GitHub token permissions
   - Verify tag format matches pattern

### Debugging Tips

1. **Local testing**: Always test builds locally first
2. **Check logs**: Workflow logs contain detailed error information
3. **Artifact inspection**: Download and test artifacts before releasing
4. **Version conflicts**: Ensure version numbers don't conflict with existing releases

## 🔄 Workflow Triggers Summary

| Workflow | Push to main | PR | Tags | Schedule | Manual |
|----------|-------------|----|----|----------|--------|
| **CI** | ✓ | ✓ | - | - | - |
| **Build & Release** | ✓ | ✓* | ✓ | - | ✓ |
| **Nightly** | - | - | - | Daily 2AM UTC | ✓ |

*PR triggers only run quick build checks, not full releases.

## 📜 Additional Resources

- [Electron Forge Documentation](https://www.electronforge.io/)
- [GitHub Actions Documentation](https://docs.github.com/en/actions)
- [Dyad Contributing Guidelines](../CONTRIBUTING.md)

---

🎉 **Enjoy automated building and releasing of your Dyad app!**