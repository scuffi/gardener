declare module "*.sql" {
  const source: string;
  export default source;
}

declare module "virtual:flue/worker" {
  const worker: ExportedHandler;
  export default worker;
}
