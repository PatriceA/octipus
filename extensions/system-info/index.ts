import type { PluginContext } from '../../src/plugins/types';

export default {
  name: 'system-info',

  async initialize(context: PluginContext): Promise<void> {
    context.logger.info('System Info plugin initialized');
  },

  tools: {
    async disk_usage(args: Record<string, unknown>): Promise<unknown> {
      try {
        // Execute df -h command
        const proc = Bun.spawn(['df', '-h'], {
          stdout: 'pipe',
          stderr: 'pipe'
        });

        const stdout = await new Response(proc.stdout).text();
        const stderr = await new Response(proc.stderr).text();
        const exitCode = await proc.exited;

        if (exitCode !== 0) {
          return { error: `df command failed: ${stderr.trim()}` };
        }

        // Parse the output
        const lines = stdout.trim().split('\n');
        const filesystems = [];

        // Skip the header line (index 0) and process each line
        for (let i = 1; i < lines.length; i++) {
          const line = lines[i].trim();
          if (!line) continue;

          // Split by whitespace, handling multiple spaces
          const parts = line.split(/\s+/);
          
          // Expected format: Filesystem Size Used Avail Use% Mounted on
          if (parts.length >= 6) {
            const filesystem = {
              filesystem: parts[0],
              size: parts[1],
              used: parts[2],
              available: parts[3],
              use_percentage: parts[4],
              mount_point: parts.slice(5).join(' ') // Handle mount points with spaces
            };
            filesystems.push(filesystem);
          }
        }

        return {
          success: true,
          filesystems,
          raw_output: stdout.trim()
        };
      } catch (err: any) {
        return { error: `Failed to get disk usage: ${err.message}` };
      }
    },

    async top_processes(args: Record<string, unknown>): Promise<unknown> {
      try {
        // Get count parameter with default of 5
        const count = Math.max(1, Math.min(Number(args.count) || 5, 100)); // Limit to 100 max
        
        // Execute ps aux --sort=-%mem command
        const proc = Bun.spawn(['ps', 'aux', '--sort=-%mem'], {
          stdout: 'pipe',
          stderr: 'pipe'
        });

        const stdout = await new Response(proc.stdout).text();
        const stderr = await new Response(proc.stderr).text();
        const exitCode = await proc.exited;

        if (exitCode !== 0) {
          return { error: `ps command failed: ${stderr.trim()}` };
        }

        // Parse the output
        const lines = stdout.trim().split('\n');
        const processes = [];

        // Skip the header line (index 0) and process top N lines
        for (let i = 1; i < Math.min(lines.length, count + 1); i++) {
          const line = lines[i].trim();
          if (!line) continue;

          // Split by whitespace, but preserve the command column (last)
          const parts = line.split(/\s+/);
          
          // Expected format: USER PID %CPU %MEM VSZ RSS TTY STAT START TIME COMMAND
          if (parts.length >= 11) {
            // The command may contain spaces, so join everything from index 10 onward
            const command = parts.slice(10).join(' ');
            
            const processInfo = {
              user: parts[0],
              pid: parseInt(parts[1], 10),
              cpu_percentage: parseFloat(parts[2]),
              mem_percentage: parseFloat(parts[3]),
              vsz: parts[4],
              rss: parts[5],
              tty: parts[6],
              stat: parts[7],
              start: parts[8],
              time: parts[9],
              command: command,
              name: command.split(' ')[0] // Extract the command name
            };
            processes.push(processInfo);
          }
        }

        return {
          success: true,
          count: processes.length,
          processes,
          raw_output: stdout.trim().split('\n').slice(0, count + 1).join('\n')
        };
      } catch (err: any) {
        return { error: `Failed to get top processes: ${err.message}` };
      }
    },

    async port_check(args: Record<string, unknown>): Promise<unknown> {
      try {
        const host = args.host as string;
        const port = Number(args.port);

        if (!host) {
          return { error: 'Host parameter is required' };
        }

        if (!port || port < 1 || port > 65535) {
          return { error: 'Port must be a valid number between 1 and 65535' };
        }

        const startTime = Date.now();
        
        try {
          // Try to connect to the host:port
          const socket = await Bun.connect({
            hostname: host,
            port: port,
            socket: {
              data() {},
              open() {
                // Connection successful
                socket.end();
              },
              error(error) {
                // Connection failed
                throw error;
              },
              close() {}
            }
          });

          const endTime = Date.now();
          const responseTime = endTime - startTime;

          return {
            success: true,
            reachable: true,
            host,
            port,
            response_time_ms: responseTime,
            message: `Successfully connected to ${host}:${port} in ${responseTime}ms`
          };
        } catch (connectError: any) {
          const endTime = Date.now();
          const responseTime = endTime - startTime;

          return {
            success: false,
            reachable: false,
            host,
            port,
            response_time_ms: responseTime,
            error: connectError.message,
            message: `Failed to connect to ${host}:${port} - ${connectError.message}`
          };
        }
      } catch (err: any) {
        return { error: `Failed to check port: ${err.message}` };
      }
    },
  },

  async shutdown(): Promise<void> {
    // No cleanup needed
  },
};