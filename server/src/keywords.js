// Job-description keyword matching. A keyword counts as "yours" only when it (or a known alias)
// appears somewhere in your resumes; anything else is reported as missing, never added.

// True synonyms only. Related-but-different tools (Pinecone vs pgvector, Jenkins vs GitHub Actions)
// must not satisfy each other, or the resume would claim things you haven't used.
const ALIASES = [
  ['postgresql', 'postgres', 'psql'],
  ['kubernetes', 'k8s'],
  ['javascript', 'js', 'ecmascript'],
  ['typescript', 'ts'],
  ['nodejs', 'node', 'node.js'],
  ['nextjs', 'next.js'],
  ['reactjs', 'react', 'react.js'],
  ['golang', 'go'],
  ['cicd', 'ci/cd', 'continuousintegration'],
  ['aws', 'amazonwebservices'],
  ['gcp', 'googlecloud', 'googlecloudplatform'],
  ['azure', 'microsoftazure'],
  ['machinelearning', 'ml'],
  ['deeplearning', 'dl'],
  ['artificialintelligence', 'ai'],
  ['naturallanguageprocessing', 'nlp'],
  ['computervision', 'cv'],
  ['largelanguagemodels', 'largelanguagemodel', 'llm', 'llms'],
  ['generativeai', 'genai'],
  ['retrievalaugmentedgeneration', 'rag'],
  ['restapi', 'restapis', 'rest', 'restful', 'restfulapis'],
  ['microservices', 'microservice'],
  ['finetuning', 'finetune'],
  ['vectordatabase', 'vectordatabases', 'vectordb', 'vectorstore'],
  ['datastructures', 'datastructure', 'dsa'],
  ['systemdesign', 'hldlld'],
  ['hld', 'highleveldesign'],
  ['lld', 'lowleveldesign'],
  ['objectorientedprogramming', 'oop', 'oops'],
  ['apachekafka', 'kafka'],
  ['mongodb', 'mongo'],
  ['scikitlearn', 'sklearn'],
  ['agenticai', 'aiagents', 'agentic'],
  ['promptengineering', 'prompting'],
  ['shellscripting', 'bashscripting'],
  ['unittesting', 'unittests', 'unittest', 'unitandintegrationtesting'],
  ['integrationtesting', 'integrationtests', 'unitandintegrationtesting'],
  ['graphql', 'graphqlapis', 'graphqlapi'],
  ['awslambda', 'lambda'],
  ['awsecs', 'ecs', 'elasticcontainerservice'],
  ['awss3', 's3'],
  ['awsec2', 'ec2'],
  ['voiceai', 'speechai', 'voiceaiasrtts'],
];

// Common tech terms, always looked for in the job description, so coverage never depends on
// the AI remembering to list them.
export const TECH_TERMS = `Python,Java,JavaScript,TypeScript,Go,Golang,Rust,C++,C#,C,Kotlin,Swift,Scala,Ruby,PHP,R,SQL,Bash,
React,Next.js,Vue,Angular,Svelte,Redux,Tailwind,HTML,CSS,Node.js,Express,NestJS,Django,Flask,FastAPI,Spring,Spring Boot,.NET,Rails,
REST APIs,GraphQL,gRPC,WebSockets,Microservices,Event-driven,Kafka,RabbitMQ,SQS,Redis,Memcached,PostgreSQL,MySQL,MongoDB,DynamoDB,
Cassandra,Elasticsearch,SQLite,Snowflake,BigQuery,Redshift,Spark,Hadoop,Airflow,dbt,ETL,Data pipelines,Pandas,NumPy,
AWS,Lambda,ECS,EKS,EC2,S3,SageMaker,Bedrock,API Gateway,CloudWatch,IAM,GCP,Vertex AI,Azure,Azure ML,Docker,Kubernetes,Helm,Terraform,
Ansible,CI/CD,GitHub Actions,Jenkins,GitLab CI,ArgoCD,Prometheus,Grafana,Datadog,OpenTelemetry,Linux,Git,Nginx,Serverless,
Machine Learning,Deep Learning,PyTorch,TensorFlow,Keras,JAX,scikit-learn,XGBoost,LightGBM,Hugging Face,Transformers,BERT,
LLMs,RAG,LangChain,LangGraph,LlamaIndex,Vector databases,Pinecone,pgvector,FAISS,Weaviate,Chroma,Milvus,Embeddings,
Fine-tuning,LoRA,QLoRA,RLHF,Prompt engineering,AI agents,Agentic AI,Tool calling,Function calling,Evals,LLM evaluation,
vLLM,TensorRT,ONNX,CUDA,Triton,Quantization,Inference optimization,Model serving,MLOps,MLflow,Kubeflow,Weights & Biases,
Computer Vision,OpenCV,NLP,Speech recognition,ASR,TTS,Voice AI,Recommender systems,Time series,A/B testing,Statistics,
Data analysis,Data visualization,Power BI,Tableau,Excel,Looker,Jupyter,
Data structures,Algorithms,System design,HLD,LLD,OOP,Design patterns,Distributed systems,Caching,Sharding,Load balancing,
Concurrency,Multithreading,Unit testing,Integration testing,TDD,PyTest,Jest,Selenium,Playwright,Cypress,Postman,
Agile,Scrum,Jira,Payments,Fintech,Security,OAuth,JWT,Blockchain,Solidity,Android,iOS,React Native,Flutter`.split(',').map((t) => t.trim()).filter(Boolean);

// Not skills: requirements about experience, process or attitude.
const NOT_A_SKILL = /experience|review|on-?call|ownership|communication|team|fundamental|graduate|degree|b\.?tech|production systems?|backend services?|clean code|problem.solving|passion|startup|fast-paced|end to end|years?/i;

export const norm = (s) => String(s || '').toLowerCase().replace(/\+\+/g, 'pp').replace(/#/g, 'sharp').replace(/[^a-z0-9]/g, '');

const groupOf = new Map();
for (const g of ALIASES) for (const a of g) {
  const k = norm(a);
  if (!groupOf.has(k)) groupOf.set(k, []);
  groupOf.get(k).push(g);
}

// "REST/GraphQL APIs" -> ["REST", "GraphQL APIs"]; "AWS (EC2, S3)" -> ["AWS", "EC2", "S3"]
export const parts = (term) =>
  String(term)
    .split(/[/,()&]|\s\+\s|\band\b|\bor\b/i)
    .map((p) => p.trim())
    .filter((p) => p.length > 0 && p.length < 60);

function variants(term) {
  const n = norm(term);
  const out = new Set([n]);
  for (const g of groupOf.get(n) || []) for (const a of g) out.add(norm(a));
  // "GraphQL APIs" should match "GraphQL"
  const stripped = n.replace(/(apis?|framework|library|tools?|platform|services?|workflows?|systems?|pipelines?)$/, '');
  if (stripped.length > 2) out.add(stripped);
  return [...out].filter(Boolean);
}

// One key per meaning: "GraphQL APIs" and "GraphQL", "Kafka" and "Apache Kafka" share a key.
export const canonical = (term) => variants(term).sort()[0];

// Short tokens (Go, C, R, AI, ML) need whole-word matches or they hit inside other words.
function present(v, rawLower, hayNorm) {
  if (v.length <= 3) return new RegExp(`(^|[^a-z0-9+#])${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9+#]|$)`).test(rawLower);
  return hayNorm.includes(v);
}

export function makeMatcher(text) {
  const rawLower = String(text || '').toLowerCase();
  const hayNorm = norm(text);
  // Whole words (and 2-3 word runs, so "node js" = "nodejs") for single-word skills:
  // "Scala" must not match "scalable", "Java" must not match "JavaScript".
  const toks = rawLower.split(/[^a-z0-9+#.]+/).map((t) => t.replace(/^\.+|\.+$/g, '')).filter(Boolean);
  const words = new Set();
  toks.forEach((t, i) => {
    words.add(norm(t));
    if (toks[i + 1]) words.add(norm(t + toks[i + 1]));
    if (toks[i + 2]) words.add(norm(t + toks[i + 1] + toks[i + 2]));
  });
  const singleWord = (term) => !/\s/.test(String(term).trim());
  const literal = (term) => {
    const t = String(term).toLowerCase().trim();
    return t.length > 0 && new RegExp(`(^|[^a-z0-9+#])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9+#]|$)`).test(rawLower);
  };
  const has = (term) =>
    literal(term) || variants(term).some((v) => (singleWord(term) ? words.has(v) : present(v, rawLower, hayNorm)));
  // A compound term ("Docker and Kubernetes") is supported only if every part is.
  return (term) => {
    const ps = parts(term);
    return ps.length > 1 ? ps.every(has) : has(term);
  };
}

// Words that are only meaningful inside a longer skill name ("Unit and Integration Testing").
const GENERIC = new Set(['unit', 'integration', 'testing', 'design', 'data', 'development', 'engineering', 'management', 'analysis', 'systems', 'system', 'web', 'cloud', 'api', 'apis', 'tools', 'programming', 'optimization', 'models', 'model']);

// Every skill from your profile that the job description mentions (exact or alias).
export function profileSkillsInJD(profile, jdText) {
  const inJD = makeMatcher(jdText);
  const out = [];
  const seen = new Set();
  for (const s of profile.skills || []) {
    for (const item of s.items || []) {
      for (const p of [item, ...parts(item)]) {
        const k = norm(p);
        if (!k || seen.has(k) || k.length < 2 || GENERIC.has(k)) continue;
        if (inJD(p)) {
          seen.add(k);
          out.push(p.trim());
          break;
        }
      }
    }
  }
  return out;
}

// Split JD keywords into the ones you have (with the JD's spelling) and the ones you don't.
export function coverage(jdKeywords, profileText) {
  const mine = makeMatcher(profileText);
  const matched = [];
  const missing = [];
  const seen = new Set();
  // "Vector databases (Pinecone, pgvector)" -> "Vector databases", "Pinecone", "pgvector": each tool is checked on its own.
  const expanded = jdKeywords.flatMap((kw) => {
    const m = String(kw).match(/^([^(]+)\(([^)]+)\)\s*$/);
    return m ? [m[1].trim(), ...m[2].split(/,|\bor\b|\band\b/).map((x) => x.trim())] : [kw];
  });
  for (const kw of expanded) {
    const term = String(kw).trim();
    if (!term || term.length > 40 || NOT_A_SKILL.test(term)) continue;
    // A compound ("HLD/LLD") is a duplicate when all its parts were already counted, and vice versa.
    const keys = [canonical(term), ...parts(term).map(canonical)];
    if (keys.every((k) => seen.has(k)) || seen.has(keys[0])) continue;
    keys.forEach((k) => seen.add(k));
    (mine(term) ? matched : missing).push(term);
  }
  return { matched, missing };
}

// Tech terms the job description mentions, from the built-in list.
export const techTermsInJD = (jdText) => {
  const inJD = makeMatcher(jdText);
  return TECH_TERMS.filter((t) => t.length > 1 && inJD(t));
};
