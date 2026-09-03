#!/usr/bin/env python3
"""Run a flutter runner on a real pty whose keyboard input comes from a FIFO.

WHY THIS EXISTS. A genuine hot reload/restart is the flutter TOOL's own `r`/`R`
over its interactive stdin, and the flutter tool only reads keys when stdin is a
TERMINAL: `Terminal.singleCharMode`'s setter returns early unless
`stdinHasTerminal`, and keystrokes are only meaningful in single-char mode. So
redirecting the runner's stdin straight at a FIFO (`flutter run … <&3`) makes
every `r`/`R` land in a pipe nobody reads — the write succeeds and nothing
happens.

`script` cannot bridge the gap on macOS: it ioctls its OWN stdin at startup, and
with a FIFO there it dies with `tcgetattr/ioctl: Operation not supported on
socket` (reproduced). So this process is the bridge instead:

    FIFO (durable, on disk)  →  this process  →  pty master
                                                    ↓
                                       flutter, with a real tty on stdin

The FIFO stays the durable half — its path is recorded in the launch registry, so
any later MCP process (or a restarted server) can append a control char and reach
the same running daemon. The pty half is what makes the flutter tool actually
read it. Output from the pty is copied to this process's stdout, which the launch
tees to the log the VM-service URI is parsed out of, so the runner still sees a
terminal for its own line-flushing exactly as it did under `script`.

Usage: pty-control-forward.py <fifo-path> <shell-command>

The command is run with `/bin/sh -c`, so a compound command works unchanged.
Exits with the child's status (or 128+signal when it was signalled).
"""

import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios

# A stable window size for the child's terminal. A pty opened with no winsize
# reports 0 columns, which makes the flutter tool's output wrapping behave as if
# the terminal were infinitely narrow.
_ROWS = 40
_COLUMNS = 120

_CHUNK = 8192


def _set_window_size(fd: int) -> None:
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", _ROWS, _COLUMNS, 0, 0))
    except OSError:
        pass


def _forward(master_fd: int, fifo_fd: int) -> None:
    """Copy pty → stdout and FIFO → pty until the child's pty closes."""
    while True:
        try:
            readable, _, _ = select.select([master_fd, fifo_fd], [], [])
        except (OSError, select.error, InterruptedError):
            return
        if master_fd in readable:
            try:
                chunk = os.read(master_fd, _CHUNK)
            except OSError:
                # The child exited and closed the slave side.
                return
            if not chunk:
                return
            try:
                os.write(1, chunk)
            except OSError:
                return
        if fifo_fd in readable:
            try:
                chunk = os.read(fifo_fd, _CHUNK)
            except OSError:
                chunk = b""
            if chunk:
                try:
                    os.write(master_fd, chunk)
                except OSError:
                    return


def main(argv: list) -> int:
    if len(argv) != 3:
        sys.stderr.write("usage: pty-control-forward.py <fifo-path> <command>\n")
        return 2
    fifo_path, command = argv[1], argv[2]

    # O_RDWR, not O_RDONLY: a FIFO reader sees EOF the moment the last writer
    # closes, so a one-shot `printf > fifo` would otherwise end the stream (and
    # spin this loop) after the first control char. Holding it read-write means
    # the pipe always has a writer and EOF never fires between appends.
    try:
        fifo_fd = os.open(fifo_path, os.O_RDWR)
    except OSError as error:
        sys.stderr.write("pty-control-forward: cannot open %s: %s\n" % (fifo_path, error))
        return 2

    pid, master_fd = pty.fork()
    if pid == 0:
        # Child: the pty slave is already stdin/stdout/stderr and the controlling
        # terminal, which is the whole point — flutter sees a real terminal.
        os.execv("/bin/sh", ["/bin/sh", "-c", command])
        os._exit(127)  # execv only returns on failure

    _set_window_size(master_fd)
    # The runner owns its own Ctrl-C handling through the pty; a SIGINT delivered
    # to this bridge must not kill the launch it is holding open.
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    _forward(master_fd, fifo_fd)

    try:
        _, status = os.waitpid(pid, 0)
    except OSError:
        return 0
    if os.WIFSIGNALED(status):
        return 128 + os.WTERMSIG(status)
    return os.WEXITSTATUS(status)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
