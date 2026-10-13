"""Run a command in a pseudo-terminal, answering each prompt with Enter (its default).

The shadcn-svelte CLI asks its questions through a TTY prompt library even
with flags; this accepts every default, as a user pressing Enter would.
usage: python3 drive.py <command> [args...]
"""
import os
import pty
import select
import sys
import time

args = sys.argv[1:]
pid, fd = pty.fork()
if pid == 0:
    os.execvp(args[0], args)
last = time.time()
while True:
    ready, _, _ = select.select([fd], [], [], 1.0)
    if ready:
        try:
            data = os.read(fd, 4096)
        except OSError:
            break
        if not data:
            break
        sys.stdout.write(data.decode(errors="ignore"))
        sys.stdout.flush()
        last = time.time()
    elif time.time() - last > 2.5:
        # Quiet for a while: a prompt waits for its answer.
        os.write(fd, b"\r")
        last = time.time()
_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status))
