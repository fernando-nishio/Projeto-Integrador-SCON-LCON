//go:build !unix

package main

// No Windows não existe o conceito de dono por UID; nada a fazer.
func devolverAoDono(path, repo string) {}
