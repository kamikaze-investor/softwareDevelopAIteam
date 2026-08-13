# AI Team DB Backup systemd units

These files are templates for a user-level systemd timer.

1. Edit the placeholder absolute paths in `ai-team-db-backup.service`.
2. Copy the `.service` and `.timer` files to `~/.config/systemd/user/`.
3. Run `systemctl --user daemon-reload`.
4. Enable the timer with `systemctl --user enable --now ai-team-db-backup.timer`.

If the timer must run while the user is logged out, enable linger for that user:

```bash
loginctl enable-linger <user>
```
