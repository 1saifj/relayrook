@echo off
rem Self-locating launcher for Windows: resolves the bundled runtime relative
rem to this script, so it works from any working directory and path with spaces.
node "%~dp0..\scripts\relayrook.mjs" %*
