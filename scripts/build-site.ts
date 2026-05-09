async function main(): Promise<void> {
  console.log('build-site: starting');
  console.log('build-site: done (no-op for now)');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
