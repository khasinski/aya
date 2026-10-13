import { useCallback, useEffect, useState } from "react";

export function useWindowChrome() {
  const [isFullScreen, setIsFullScreen] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);

  // Track fullscreen state so platform chrome can change without hiding
  // Aya's normal project tabs and controls.
  useEffect(() => {
    let active = true;
    void window.aya.isFullScreen().then((fs) => {
      if (active) setIsFullScreen(fs);
    });
    const unsubscribe = window.aya.onFullScreenChange((fs) => {
      setIsFullScreen(fs);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    let active = true;
    void window.aya.isMaximized().then((maximized) => {
      if (active) setIsMaximized(maximized);
    });
    const unsubscribe = window.aya.onMaximizedChange((maximized) => {
      setIsMaximized(maximized);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const minimizeWindow = useCallback(
    () => void window.aya.minimizeWindow(),
    [],
  );
  const toggleMaximizeWindow = useCallback(
    () => void window.aya.toggleMaximizeWindow(),
    [],
  );
  const toggleFullScreenWindow = useCallback(
    () => void window.aya.setFullScreen(!isFullScreen),
    [isFullScreen],
  );
  const closeWindow = useCallback(() => void window.aya.closeWindow(), []);

  return {
    isFullScreen,
    isMaximized,
    minimizeWindow,
    toggleMaximizeWindow,
    toggleFullScreenWindow,
    closeWindow,
  };
}
