/**
 * Liquibase Installation and Setup Module
 * 
 * This module contains the core logic for:
 * - Downloading and installing Liquibase (OSS and Pro editions)
 * - Version resolution and management
 * - Cross-platform support (Linux, Windows, macOS)
 * - Caching for improved performance
 * - License configuration for Pro edition
 * - Installation validation
 */

import * as core from '@actions/core';
import * as tc from '@actions/tool-cache';
import * as exec from '@actions/exec';
import * as path from 'path';
import * as fs from 'fs';
import { DOWNLOAD_URLS, MIN_SUPPORTED_VERSION } from './config';
import * as semver from 'semver';

/**
 * Configuration options for setting up Liquibase
 */
export interface LiquibaseSetupOptions {
  /** Specific version to install (must be 4.32.0 or higher) */
  version: string;
  /** Edition to install: 'oss' for Open Source, 'pro' for Professional */
  edition: 'oss' | 'pro';
  /** License key for Pro edition from LIQUIBASE_LICENSE_KEY environment variable */
  licenseKey?: string;
  /** Whether to cache the downloaded installation */
  cache: boolean;
}

/**
 * Result of a successful Liquibase setup operation
 */
export interface LiquibaseSetupResult {
  /** The actual version that was installed */
  version: string;
  /** The file system path where Liquibase was installed */
  path: string;
}

/**
 * Main function to set up Liquibase in the GitHub Actions environment
 * 
 * This function coordinates the entire installation process:
 * 1. Validates Pro edition requirements
 * 2. Resolves the exact version to install
 * 3. Checks for cached installations
 * 4. Downloads and extracts Liquibase if needed
 * 5. Configures Pro license if applicable
 * 6. Validates the installation
 * 7. Adds Liquibase to the system PATH
 * 
 * @param options - Configuration for the Liquibase setup
 * @returns Promise resolving to the setup result with version and path
 */
export async function setupLiquibase(options: LiquibaseSetupOptions): Promise<LiquibaseSetupResult> {
  const { version, edition, licenseKey, cache } = options;
  
  // Validate version requirement
  if (!semver.valid(version)) {
    throw new Error(`Invalid version format: ${version}. Must be a valid semantic version (e.g., "4.32.0")`);
  }
  
  if (semver.lt(version, MIN_SUPPORTED_VERSION)) {
    throw new Error(`Version ${version} is not supported. Minimum supported version is ${MIN_SUPPORTED_VERSION}`);
  }
  
  // Validate Pro edition requirements
  if (edition === 'pro' && !licenseKey) {
    throw new Error('License key is required for Liquibase Pro edition');
  }
  
  // Use the provided version directly (no resolution needed since we require specific versions)
  const resolvedVersion = version;
  
  // Create a unique tool name for caching that includes the edition
  const toolName = `liquibase-${edition}`;
  
  // Check if we already have this version cached
  let toolPath = tc.find(toolName, resolvedVersion);
  
  // Download and install if not cached or caching is disabled
  if (!toolPath || !cache) {
    core.info(`Installing Liquibase ${edition} version ${resolvedVersion}`);
    
    // Get the appropriate download URL for this version and edition
    const downloadUrl = getDownloadUrl(resolvedVersion, edition);
    
    // Download the Liquibase archive
    const downloadPath = await tc.downloadTool(downloadUrl);
    
    // Extract the archive to a temporary directory
    const extractedPath = await extractLiquibase(downloadPath);
    
    // Cache the installation if caching is enabled
    if (cache) {
      toolPath = await tc.cacheDir(extractedPath, toolName, resolvedVersion);
    } else {
      toolPath = extractedPath;
    }
  } else {
    core.info(`Found cached Liquibase ${edition} version ${resolvedVersion}`);
  }
  
  // Construct the path to the Liquibase executable
  const liquibaseBinPath = path.join(toolPath, 'liquibase');
  
  // Add the tool directory to the system PATH so 'liquibase' command is available
  core.addPath(toolPath);
  
  // Configure Pro license if this is a Pro installation
  if (edition === 'pro' && licenseKey) {
    await configureLiquibasePro(toolPath, licenseKey);
  }
  
  // Verify that the installation was successful
  await validateInstallation(liquibaseBinPath);
  
  // Return the results for use by the action
  return {
    version: resolvedVersion,
    path: toolPath
  };
}

/**
 * Constructs the download URL for a specific Liquibase version and edition
 * Uses official Liquibase download endpoints
 * 
 * @param version - Exact version number to download
 * @param edition - Edition to download ('oss' or 'pro')
 * @returns Download URL for the specified version from official Liquibase endpoints
 */
export function getDownloadUrl(version: string, edition: 'oss' | 'pro'): string {
  const isWindows = process.platform === 'win32';
  
  if (edition === 'pro') {
    const template = isWindows ? DOWNLOAD_URLS.PRO_WINDOWS_ZIP : DOWNLOAD_URLS.PRO_UNIX;
    return template.replace(/\{version\}/g, version);
  } else {
    const template = isWindows ? DOWNLOAD_URLS.OSS_WINDOWS_ZIP : DOWNLOAD_URLS.OSS_UNIX;
    return template.replace(/\{version\}/g, version);
  }
}


/**
 * Extracts a downloaded Liquibase archive to a temporary directory
 * 
 * @param downloadPath - Path to the downloaded archive file
 * @returns Promise resolving to the path of the extracted directory
 */
async function extractLiquibase(downloadPath: string): Promise<string> {
  const platform = process.platform;
  
  if (platform === 'win32') {
    // Extract ZIP archives (Windows)
    return await tc.extractZip(downloadPath);
  } else {
    // Extract tar.gz archives (Linux, macOS)
    return await tc.extractTar(downloadPath, undefined, 'xz');
  }
}

/**
 * Configures Liquibase Pro by creating a properties file with the license key
 * 
 * @param toolPath - Directory where Liquibase is installed
 * @param licenseKey - Pro license key to configure
 */
async function configureLiquibasePro(toolPath: string, licenseKey: string): Promise<void> {
  // Create liquibase.properties file in the installation directory
  const propertiesPath = path.join(toolPath, 'liquibase.properties');
  const propertiesContent = `liquibase.licenseKey=${licenseKey}\n`;
  
  await fs.promises.writeFile(propertiesPath, propertiesContent);
  core.info('Configured Liquibase Pro license key');
}

/**
 * Validates that Liquibase was installed correctly by running --version command
 * 
 * @param liquibasePath - Path to the Liquibase executable (without extension)
 * @throws Error if the validation fails
 */
async function validateInstallation(liquibasePath: string): Promise<void> {
  try {
    // On Windows, Liquibase uses .bat extension; Unix systems use the binary directly
    const executable = process.platform === 'win32' ? `${liquibasePath}.bat` : liquibasePath;
    
    // Run 'liquibase --version' to verify the installation works
    await exec.exec(executable, ['--version'], { silent: true });
    core.info('Liquibase installation validated successfully');
  } catch (error) {
    throw new Error(`Failed to validate Liquibase installation: ${error}`);
  }
}