import electronLog from "electron-log/main";

/**
 * File + console log (%APPDATA%\priinteve-zerox-desktop\logs\main.log).
 * Never logs document contents, file URLs or tokens.
 */
electronLog.initialize();
electronLog.transports.file.maxSize = 5 * 1024 * 1024;

export const log = electronLog;
