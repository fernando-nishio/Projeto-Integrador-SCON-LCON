//go:build unix

package main

import (
	"os"
	"syscall"
)

// devolverAoDono: quando o setup roda como root (no Docker), o .env criado seria
// do root e você não conseguiria editá-lo. Aqui ele passa a ser do mesmo dono da
// pasta do projeto, ou seja, o seu usuário.
func devolverAoDono(path, repo string) {
	if os.Geteuid() != 0 {
		return
	}
	info, err := os.Stat(repo)
	if err != nil {
		return
	}
	if st, ok := info.Sys().(*syscall.Stat_t); ok {
		os.Chown(path, int(st.Uid), int(st.Gid))
	}
}
