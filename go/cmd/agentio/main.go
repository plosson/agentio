package main

import (
	"os"

	"github.com/plosson/agentio/go/internal/cli"
)

func main() {
	os.Exit(cli.Main(os.Args[1:]))
}
