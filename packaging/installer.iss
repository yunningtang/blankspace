; Inno Setup 安装程序。在 Windows 上：
;   ISCC.exe /DAppVersion=0.6.0 packaging\installer.iss
; 装到当前用户自己的目录，不需要管理员权限。

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif

[Setup]
AppId={{6B1E2B7A-3C1F-4E7B-9A55-5F0C9B2D7A11}
AppName=留白
AppVersion={#AppVersion}
AppVerName=留白 {#AppVersion}
AppPublisher=yunningtang
AppPublisherURL=https://github.com/yunningtang/blankspace
AppSupportURL=https://github.com/yunningtang/blankspace/issues
DefaultDirName={localappdata}\Programs\Liubai
DefaultGroupName=留白
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=..\dist
OutputBaseFilename=Liubai-Setup-{#AppVersion}
SetupIconFile=liubai.ico
UninstallDisplayIcon={app}\Liubai.exe
UninstallDisplayName=留白
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
InfoBeforeFile=before-install.txt
ChangesAssociations=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

[Languages]
#if FileExists(SourcePath + "ChineseSimplified.isl")
Name: "chs"; MessagesFile: "ChineseSimplified.isl"
#endif
Name: "en"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked
Name: "contextmenu"; Description: "在资源管理器的右键菜单里加“用留白看看这里”（只是打开留白看看，不会动文件）"; GroupDescription: "右键菜单："

[Files]
Source: "..\dist\Liubai\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\留白"; Filename: "{app}\Liubai.exe"
Name: "{autodesktop}\留白"; Filename: "{app}\Liubai.exe"; Tasks: desktopicon

[Registry]
; 只写当前用户（HKCU），不需要管理员权限；卸载时一起删掉。
Root: HKCU; Subkey: "Software\Classes\Directory\shell\Liubai"; ValueType: string; ValueName: ""; ValueData: "用留白看看这里"; Flags: uninsdeletekey; Tasks: contextmenu
Root: HKCU; Subkey: "Software\Classes\Directory\shell\Liubai"; ValueType: string; ValueName: "Icon"; ValueData: "{app}\Liubai.exe"; Tasks: contextmenu
Root: HKCU; Subkey: "Software\Classes\Directory\shell\Liubai\command"; ValueType: string; ValueName: ""; ValueData: """{app}\Liubai.exe"" ""%1"""; Tasks: contextmenu
Root: HKCU; Subkey: "Software\Classes\Directory\Background\shell\Liubai"; ValueType: string; ValueName: ""; ValueData: "用留白看看这里"; Flags: uninsdeletekey; Tasks: contextmenu
Root: HKCU; Subkey: "Software\Classes\Directory\Background\shell\Liubai"; ValueType: string; ValueName: "Icon"; ValueData: "{app}\Liubai.exe"; Tasks: contextmenu
Root: HKCU; Subkey: "Software\Classes\Directory\Background\shell\Liubai\command"; ValueType: string; ValueName: ""; ValueData: """{app}\Liubai.exe"" ""%V"""; Tasks: contextmenu
Root: HKCU; Subkey: "Software\Classes\Drive\shell\Liubai"; ValueType: string; ValueName: ""; ValueData: "用留白看看这里"; Flags: uninsdeletekey; Tasks: contextmenu
Root: HKCU; Subkey: "Software\Classes\Drive\shell\Liubai"; ValueType: string; ValueName: "Icon"; ValueData: "{app}\Liubai.exe"; Tasks: contextmenu
Root: HKCU; Subkey: "Software\Classes\Drive\shell\Liubai\command"; ValueType: string; ValueName: ""; ValueData: """{app}\Liubai.exe"" ""%1"""; Tasks: contextmenu

[Run]
Filename: "{app}\Liubai.exe"; Description: "{cm:LaunchProgram,留白}"; Flags: nowait postinstall skipifsilent

; 卸载时只删程序本身。清理记录和设置（%LOCALAPPDATA%\Liubai）留着，用户自己决定。

[Code]
// 新界面需要 Microsoft Edge WebView2（Windows 11 自带，大部分 Windows 10 也有）。没有就提醒用户去装。
function HasWebView2(): Boolean;
var v: String;
begin
  Result :=
    (RegQueryStringValue(HKLM, 'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', v) and (v <> '') and (v <> '0.0.0.0')) or
    (RegQueryStringValue(HKLM, 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', v) and (v <> '') and (v <> '0.0.0.0')) or
    (RegQueryStringValue(HKCU, 'Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', v) and (v <> '') and (v <> '0.0.0.0'));
end;

procedure CurStepChanged(CurStep: TSetupStep);
var code: Integer;
begin
  if (CurStep = ssPostInstall) and (not HasWebView2()) and (not WizardSilent()) then
    if MsgBox('留白的界面需要 Microsoft Edge WebView2，这台电脑上好像还没有。' + #13#10 +
              '没有的话会先用简洁界面。现在打开下载页面吗？', mbConfirmation, MB_YESNO) = IDYES then
      ShellExec('open', 'https://developer.microsoft.com/microsoft-edge/webview2/', '', '', SW_SHOWNORMAL, ewNoWait, code);
end;
