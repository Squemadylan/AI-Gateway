; AI Gateway 0.9.9 安装包定义
;
; 由 build-installer.ps1 生成产物，**不写 LicenseFile**：用户要求安装包里不带授权文件。
; 安装流程刻意压到三步：选目录 → 安装 → 完成（DisableProgramGroupPage 去掉程序组页）。

[Setup]
AppId={{8E4C1A72-9F3B-4D6A-B0E7-2C9A5D1F6B83}
AppName=AI Gateway
AppVersion=0.9.9
AppPublisher=AIGateway
DefaultDirName={autopf}\AI Gateway
DefaultGroupName=AI Gateway
DisableProgramGroupPage=yes
; **必须显式写 no**：Inno Setup 在 PrivilegesRequired=lowest 时把 DisableDirPage
; 默认成 `auto`（等于跳过），向导会直接不显示「选择安装位置」页——实测就是这个症状。
; 用户要求能自己选目录，所以强制打开。
DisableDirPage=no
; 重装时记住上次选的目录（升级不必每次重挑）
UsePreviousAppDir=yes
OutputDir=__OUTDIR__
OutputBaseFilename=AI-Gateway-Setup-0.9.9
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
; 允许自选目录 ⇒ 可能落到 Program Files 这类只读位置；lowest 权限会被拒绝写入。
; 改成 admin，默认目录随之解析成 C:\Program Files\AI Gateway。
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayIcon={app}\AI Gateway.exe
; 升级覆盖时不弹「文件已存在」询问
DirExistsWarning=no
; 目录页上「安装需要约 XX MB」的数字。
; 不写的话 Inno 会按压缩比估算，实测显示 55.9 MB 而实际落盘约 52 MB（含 runtime 46 MB），
; 数字偏大反而让人犹豫。写实际值。
ExtraDiskSpaceRequired=0

[Languages]
; 简体中文语言包不随 Inno Setup 官方安装包分发（官方只到日/韩/繁也没到简）。
; 这里用项目内的副本，避免依赖系统上有没有人手动装过。
Name: "chs"; MessagesFile: "__LANGDIR__\ChineseSimplified.isl"

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "快捷方式："; Flags: unchecked

[Files]
Source: "__SRC__\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\AI Gateway"; Filename: "{app}\AI Gateway.exe"
Name: "{group}\卸载 AI Gateway"; Filename: "{app}\unins000.exe"

[Run]
Filename: "{app}\AI Gateway.exe"; Description: "启动 AI Gateway"; Flags: nowait postinstall skipifsilent

[Code]
// 桌面快捷方式：**不能**在 [Icons] 里直接写 {userdesktop}。
//
// PrivilegesRequired=admin 时安装程序以提权身份运行，{userdesktop} 会解析成
// 「管理员账户」的桌面；而用户实际登录的是另一个账户 —— 快捷方式会出现在
// 一个他根本看不到的桌面上（Inno 会为此专门发 UsedUserAreasWarning 警告）。
// 这里用 shell 对象自己建 .lnk，按 IsAdminInstallMode 决定落在哪个桌面。
procedure MakeDesktopShortcut();
var
  WshShell: Variant;
  ShellLink: Variant;
  LinkPath: String;
  DesktopDir: String;
begin
  if IsAdminInstallMode() then
    DesktopDir := ExpandConstant('{commondesktop}')
  else
    DesktopDir := ExpandConstant('{userdesktop}');

  LinkPath := DesktopDir + '\AI Gateway.lnk';

  try
    // 必须分两步：Pascal Script 不支持在方法返回值上继续调方法
    // （写成 CreateOleObject('WScript.Shell').CreateShortcut(...) 会报
    //  Unknown identifier 'CREATESHORTCUT'）。
    WshShell := CreateOleObject('WScript.Shell');
    ShellLink := WshShell.CreateShortcut(LinkPath);
    ShellLink.TargetPath := ExpandConstant('{app}') + '\AI Gateway.exe';
    ShellLink.WorkingDirectory := ExpandConstant('{app}');
    ShellLink.IconLocation := ExpandConstant('{app}') + '\AI Gateway.exe,0';
    ShellLink.Description := 'AI Gateway';
    ShellLink.Save();
  except
    // 建快捷方式失败不该让整个安装失败，静默跳过
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    if WizardIsTaskSelected('desktopicon') then
      MakeDesktopShortcut();
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usPostUninstall then
  begin
    // 桌面快捷方式不由 [Icons] 管理，卸载时这里删；两个位置都试，
    // 免得从「用户安装」升级到「管理员安装」后旧链接残留。
    DeleteFile(ExpandConstant('{userdesktop}') + '\AI Gateway.lnk');
    DeleteFile(ExpandConstant('{commondesktop}') + '\AI Gateway.lnk');
  end;
end;
