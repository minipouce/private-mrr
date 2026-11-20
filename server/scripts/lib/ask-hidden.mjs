/**
 * Reads one line from the terminal without echoing it.
 *
 * Raw mode rather than readline: readline in terminal mode redraws the line it
 * is reading, and muting that redraw erases the prompt along with it — which is
 * exactly how the first version of this script managed to show nothing and read
 * nothing. Here the terminal is simply told not to echo, and no redraw happens.
 *
 * A paste arrives as one chunk, not character by character, so the newline is
 * looked for inside the chunk rather than compared against it.
 */
export function askHidden(question) {
  return new Promise((resolve) => {
    process.stdout.write(question);

    // Not a terminal (a pipe, a test): read the line plainly.
    if (!process.stdin.isTTY) {
      let piped = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (c) => { piped += c; });
      process.stdin.on('end', () => {
        process.stdout.write('\n');
        resolve(piped.split(/[\r\n]/)[0].trim());
      });
      return;
    }

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    let buffer = '';
    const done = (value) => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener('data', onData);
      process.stdout.write('\n');
      resolve(value);
    };

    const onData = (chunk) => {
      // Ctrl+C has to be handled by hand: raw mode swallows the signal.
      if (chunk.includes('\u0003')) {
        process.stdin.setRawMode(false);
        process.stdout.write('\n');
        process.exit(130);
      }

      const end = chunk.search(/[\r\n]/);
      const typed = end === -1 ? chunk : chunk.slice(0, end);

      for (const ch of typed) {
        if (ch === '\u007f' || ch === '\b') buffer = buffer.slice(0, -1);
        else if (ch >= ' ') buffer += ch;
      }

      if (end !== -1) done(buffer.trim());
    };

    process.stdin.on('data', onData);
  });
}
