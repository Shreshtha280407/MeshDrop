# Use MeshDrop

MeshDrop shares files between two browsers without creating an account. The cloud
coordinates admission; the devices transfer and verify the bytes. After public
deployment, the developer's laptop can be off. Both transfer devices must remain
online with MeshDrop open until completion.

1. Open the deployed stable HTTPS address on both devices. Use a regular browser
   profile with enough storage. The device panel reports usable storage features
   and estimated free space. Private browsing may prevent recovery.
2. The sender creates an invitation, then privately shares the invitation link or
   QR with the receiver. The receiver requests admission. The sender checks and
   approves that receiver. Invitations expire and support one approved receiver.
3. Compare the displayed codes in person or through another trusted channel.
   Enter and confirm on both devices. If codes differ, stop and create a new room.
4. The sender chooses files and selects **Offer files**. The receiver reviews the
   offer, acknowledges any large-file/storage warning, then selects **Accept files**.
   Keep both devices visible and awake. Committed progress means verified bytes
   have reached the receiver's browser storage.
5. Wait for **complete** and the verified SHA-256 result. Save the file and the
   transfer receipt. A receipt describes an application transfer, not a cloud backup
   or legally signed delivery guarantee. Use **Clear transfer** after checking the
   saved copy; it removes the temporary scoped browser files.

## Interruptions and recovery

Pause before switching apps or locking a phone where possible. Hidden/offline
events can suspend transport; returning to the foreground does not silently resume.
Keep the original source file. If the connection changes, wait for a fresh
connection and compare the new codes. The sender uses **Prepare original source**;
the receiver uses **Resume saved transfer**. Only verified retained blocks are
reused. Failed verification or an unavailable source must never show completion.

If a tab/process was closed, reopen the same origin/profile and inspect saved
transfers. Reopening validates stored checkpoints. Establish new room admission
and compare fresh codes; old browser-memory credentials are not restored. Browser
eviction, Clear site data, profile changes or a changed public domain can make
recovery unavailable. Choose 24-hour or 7-day retention, or discard. Expiry is
checked when saved data is accessed.

## Save, share and offline use

Verified surviving files can be prepared and saved from the installed/cached shell
while offline. Pairing and delivery need network access. Some browsers require a
separate preparation step before a fresh Save/Share click opens the native dialog.
Export can need additional free space. An installed PWA does not guarantee
background transfers, permanent storage, or native sharing support. A failed save
does not invalidate verified temporary data; keep it and retry an available export
method. Install/update and large-file support vary by browser/device.

## Troubleshooting

| Symptom                                                    | Action                                                                                                                                       |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Invitation expired, rejected, or receiver already assigned | Create a new invitation and approve the intended receiver.                                                                                   |
| Rate limited                                               | Wait for the displayed retry period; repeated retries consume the same budget.                                                               |
| Code mismatch                                              | Stop the room and compare through a trusted channel before any file sharing.                                                                 |
| Connecting fails across networks                           | Retry a reachable network; a direct-only preview cannot cross every NAT/firewall. Ask the operator whether a TURN relay is configured.       |
| Storage/quota check fails                                  | Free storage or use a smaller file; do not clear retained data you still need. Unknown quota permits at most a 64 MiB new offer in this app. |
| Paused after app switch/screen lock                        | Return both devices to the foreground, reconnect, compare fresh codes and explicitly resume.                                                 |
| Original source changed/missing                            | Select the exact original file; a different file cannot substitute for verified recovery.                                                    |
| Service unavailable                                        | Retain source and checkpoint, wait for the service to recover, then renew admission.                                                         |

The diagnostics panel shows measured rates, queue/recovery details and observed
connection path, with unavailable fields explicitly identified. Export a local
diagnostics JSON/CSV only if you choose to share it. Reports omit filenames,
capabilities, SDP/ICE and raw addresses, but timing/transfer identifiers can still
be linkable. See the [privacy notice](privacy-notice.md) and measured
[support matrix](support-matrix.md).
