param([Parameter(Mandatory = $true)][string]$LiteralPath)
$ErrorActionPreference = 'Stop'
$item = Get-Item -LiteralPath $LiteralPath -Force
if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Relay credential path must not be a reparse point' }
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = Get-Acl -LiteralPath $LiteralPath
$acl.SetAccessRuleProtection($true, $false)
foreach ($rule in @($acl.Access)) { $acl.RemoveAccessRuleSpecific($rule) }
if ($item.PSIsContainer) {
    $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
} else {
    $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'Allow')
}
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $LiteralPath -AclObject $acl
