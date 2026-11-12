// Read the process table in Lattice's own signed executable. Copying Apple's
// setuid /bin/ps without setuid works on some macOS versions but is killed on
// others, even when codesign --verify accepts the copy. Keep the SDK's native
// kinfo_proc layout here rather than reproducing its ABI in Rust.
#include <sys/types.h>
#include <sys/sysctl.h>
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

int lattice_process_snapshot(int with_parent, const int *pids, size_t pid_count) {
    int mib[] = {CTL_KERN, KERN_PROC, KERN_PROC_ALL, 0};
    struct kinfo_proc *processes = NULL;
    size_t size = 0;
    int error = ENOMEM;
    for (int attempt = 0; attempt < 4; attempt++) {
        size = 0;
        if (sysctl(mib, 4, NULL, &size, NULL, 0) != 0) return errno;
        // Processes can start between the sizing query and the snapshot.
        if (size > SIZE_MAX - 64 * sizeof(*processes)) return EOVERFLOW;
        size += 64 * sizeof(*processes);
        processes = malloc(size);
        if (processes == NULL) return ENOMEM;
        if (sysctl(mib, 4, processes, &size, NULL, 0) == 0) {
            error = 0;
            break;
        }
        error = errno;
        free(processes);
        processes = NULL;
        if (error != ENOMEM) return error;
    }
    if (error != 0) return error;
    if (size == 0 || size % sizeof(*processes) != 0) {
        free(processes);
        return EIO;
    }
    for (size_t i = 0; i < size / sizeof(*processes); i++) {
        const struct kinfo_proc *process = &processes[i];
        int pid = process->kp_proc.p_pid;
        if (pid <= 0) continue;
        if (!with_parent) {
            int selected = 0;
            for (size_t j = 0; j < pid_count; j++) {
                if (pids[j] == pid) selected = 1;
            }
            if (!selected) continue;
        }
        // Synara treats the command column as an opaque identity, not argv.
        // Birth time stays stable across exec/reparenting and distinguishes PID
        // reuse, without exposing prompts or credentials from command lines.
        if (with_parent) printf("%d %d ", pid, process->kp_eproc.e_ppid);
        else printf("%d ", pid);
        printf("lattice-process:%lld:%d\n",
               (long long)process->kp_proc.p_starttime.tv_sec,
               (int)process->kp_proc.p_starttime.tv_usec);
    }
    free(processes);
    return fflush(stdout) == 0 && !ferror(stdout) ? 0 : EIO;
}
