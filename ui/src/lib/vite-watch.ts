const TEST_DIRECTORY_NAMES = new Set([
  "__tests__",
  "_tests",
  "test",
  "tests",
]);

const TEST_FILE_BASENAME_RE = /\.(test|spec)\.[^/]+$/i;

export function shouldIgnoreUiDevWatchPath(watchedPath: string): boolean {
  const normalizedPath = String(watchedPath).replaceAll("\\", "/");
  if (normalizedPath.length === 0) return false;

  const segments = normalizedPath.split("/");
  const basename = segments.at(-1) ?? normalizedPath;

  return segments.some((segment) => TEST_DIRECTORY_NAMES.has(segment))
    || TEST_FILE_BASENAME_RE.test(basename);
}

export function createUiDevWatchOptions(
  currentWorkingDirectory: string,
  environment: Record<string, string | undefined> = process.env,
) {
  const pollingOverride = environment.CHOKIDAR_USEPOLLING?.toLowerCase();
  const usePolling = pollingOverride === undefined
    // WSL2 /mnt/ drives don't support inotify.
    ? currentWorkingDirectory.startsWith("/mnt/")
    : !["false", "0", ""].includes(pollingOverride);
  return {
    ignored: shouldIgnoreUiDevWatchPath,
    // Vite's bundled watcher chooses native FSEvents before reading the env
    // override. Set this option explicitly so polling actually disables it.
    ...(usePolling ? { usePolling: true, interval: 1000 } : {}),
  };
}
