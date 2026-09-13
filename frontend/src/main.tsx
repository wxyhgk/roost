import { startLibraryRuntime } from "./features/library/runtime";
import { startSessionStatus } from "./features/session-status/runtime";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { AuthGate } from "./app/AuthGate";
import { ErrorBoundary } from "./app/ErrorBoundary";
import { ThemeProvider } from "./shared/theme";
import { WorkspaceProvider } from "./shared/store";
import "./index.css";

/*
  两个后台 runtime 在这里启动。**这是组装的活**：原来 session-status 是由
  shared/store 的 WorkspaceProvider 用 useEffect 拉起来的，于是工作区状态反过来
  依赖了一个特性。时机基本没变——WorkspaceProvider 本来就在 AuthGate 外面，
  也就是登录之前就挂上了，挪到这里只是早一个 tick。
*/
const stopLibrary = startLibraryRuntime();
const stopSessionStatus = startSessionStatus();
const hot = (import.meta as ImportMeta & { hot?: { dispose(fn: () => void): void } }).hot;
hot?.dispose(stopLibrary);
hot?.dispose(stopSessionStatus);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <ThemeProvider>
        <WorkspaceProvider>
          <AuthGate>
            <App />
          </AuthGate>
        </WorkspaceProvider>
      </ThemeProvider>
    </ErrorBoundary>
  </StrictMode>,
);
