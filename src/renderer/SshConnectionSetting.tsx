// "设置 → SSH 连接 → 复用已有的 SSH 连接": kept by the main process (ssh-settings.json),
// which applies it to the backend's connections from now on.
import { useEffect, useState } from 'react';
import { defaultSshConnectionPreferences } from '../shared/ssh-connections';
import { t } from '../shared/i18n';
import { reportActionError } from './diagnostics';

export function SshConnectionSetting() {
  const [reuse, setReuse] = useState<boolean>();
  useEffect(() => {
    let live = true;
    void window.desktop.sshConnectionPreferences().then(preferences => { if (live) setReuse(preferences.reuseConnections); }).catch(() => {});
    return () => { live = false; };
  }, []);
  const change = (reuseConnections: boolean) => {
    setReuse(reuseConnections);
    void window.desktop.setSshConnectionPreferences({ reuseConnections }).then(saved => setReuse(saved.reuseConnections))
      .catch(error => reportActionError(error, 'SSH connection preference'));
  };
  return <div className="pref-ssh-connection">
    <label>{t('prefs.reuseSshConnections')}
      <input type="checkbox" aria-describedby="ssh-reuse-help" disabled={reuse === undefined}
        checked={reuse ?? defaultSshConnectionPreferences.reuseConnections} onChange={event => change(event.currentTarget.checked)} />
    </label>
    <p id="ssh-reuse-help">{t('prefs.reuseSshConnectionsHelp')}</p>
  </div>;
}
