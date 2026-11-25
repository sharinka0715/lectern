import { useEffect, useState } from 'react';
import { defaultSshConnectionPreferences, sshKeepAliveChoices, type SshConnectionPreferences, type SshKeepAliveSeconds } from '../shared/ssh-connections';
import { t, type MessageKey } from '../shared/i18n';
import { reportActionError } from './diagnostics';

const durationLabels: Record<SshKeepAliveSeconds, MessageKey> = {
  0: 'prefs.sshDisconnectOnQuit', 900: 'prefs.sshKeep15m', 3600: 'prefs.sshKeep1h',
  14400: 'prefs.sshKeep4h', 28800: 'prefs.sshKeep8h', 86400: 'prefs.sshKeep24h',
};

export function SshConnectionSetting({ platform }: { platform: string }) {
  const [settings, setSettings] = useState<SshConnectionPreferences>();
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let live = true;
    void window.desktop.sshConnectionPreferences().then(preferences => { if (live) setSettings(preferences); }).catch(() => {});
    return () => { live = false; };
  }, []);
  const change = (patch: Partial<SshConnectionPreferences>) => {
    if (!settings || saving) return;
    const next = { ...settings, ...patch };
    setSettings(next);
    setSaving(true);
    void window.desktop.setSshConnectionPreferences(next).then(setSettings).catch(error => {
      setSettings(settings);
      reportActionError(error, 'SSH connection preference');
    }).finally(() => setSaving(false));
  };
  const current = settings ?? defaultSshConnectionPreferences;
  return <div className="pref-ssh-connection">
    <label>{t('prefs.reuseSshConnections')}
      <input type="checkbox" aria-describedby="ssh-reuse-help" disabled={!settings || saving}
        checked={current.reuseConnections} onChange={event => change({ reuseConnections: event.currentTarget.checked })} />
    </label>
    <p id="ssh-reuse-help">{t('prefs.reuseSshConnectionsHelp')}</p>
    {platform !== "win32" && <>
      <label><span id="ssh-keep-label">{t('prefs.sshKeepAfterQuit')}</span>
        <select aria-labelledby="ssh-keep-label" aria-describedby="ssh-keep-help" disabled={!settings || saving} value={current.keepAliveSeconds}
          onChange={event => change({ keepAliveSeconds: Number(event.currentTarget.value) as SshKeepAliveSeconds })}>
          {sshKeepAliveChoices.map(seconds => <option key={seconds} value={seconds}>{t(durationLabels[seconds])}</option>)}
        </select>
      </label>
      <p id="ssh-keep-help">{t('prefs.sshKeepAfterQuitHelp')}</p>
    </>}
  </div>;
}
