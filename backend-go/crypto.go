package main

// Criptografia simétrica AES-256-GCM para tudo o que é guardado nos bancos.
// GCM, além de esconder o valor, detecta adulteração (auth tag): se alguém alterar
// o texto cifrado no banco, a descriptografia falha em vez de devolver lixo.
//
// Formato armazenado (o mesmo da versão em Node, então os dados são compatíveis):
//
//	"iv:tag:cifrado", cada parte em base64

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"strings"
)

type Cipher struct {
	aead cipher.AEAD // AES no modo GCM: IV de 12 bytes, tag de 16 bytes
}

func NewCipher(key []byte) (*Cipher, error) {
	block, err := aes.NewCipher(key) // chave de 32 bytes => AES-256
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return &Cipher{aead: aead}, nil
}

var b64 = base64.StdEncoding

func (c *Cipher) Encrypt(plain string) string {
	iv := make([]byte, c.aead.NonceSize())
	rand.Read(iv) // IV novo e aleatório a cada valor

	// Seal devolve [cifrado | tag]; separamos para manter o formato iv:tag:cifrado
	sealed := c.aead.Seal(nil, iv, []byte(plain), nil)
	n := len(sealed) - c.aead.Overhead()
	ct, tag := sealed[:n], sealed[n:]

	return b64.EncodeToString(iv) + ":" + b64.EncodeToString(tag) + ":" + b64.EncodeToString(ct)
}

func (c *Cipher) Decrypt(stored string) (string, error) {
	parts := strings.Split(stored, ":")
	if len(parts) != 3 {
		return "", errors.New("valor cifrado em formato inválido")
	}
	iv, err1 := b64.DecodeString(parts[0])
	tag, err2 := b64.DecodeString(parts[1])
	ct, err3 := b64.DecodeString(parts[2])
	if err := errors.Join(err1, err2, err3); err != nil {
		return "", err
	}
	// Open espera [cifrado | tag] e confere a tag antes de devolver o texto
	plain, err := c.aead.Open(nil, iv, append(ct, tag...), nil)
	if err != nil {
		return "", errors.New("falha ao descriptografar (chave errada ou dado adulterado)")
	}
	return string(plain), nil
}
