import json, subprocess

BUCKET = "bedrock-usage-intel-raw-logs-469898429403-us-east-1"
REGION = "us-east-1"
FUNCTION = "bedrock-usage-intel-invocation-processor"

result = subprocess.run(
    ["aws", "s3", "ls", f"s3://{BUCKET}/bedrock-logs/", "--recursive", "--region", REGION],
    capture_output=True, text=True
)

keys = [
    line.split()[-1] for line in result.stdout.strip().split("\n")
    if ".json.gz" in line and "/data/" not in line
]

print(f"Found {len(keys)} log files")

for key in keys:
    payload = json.dumps({
        "Records": [{"s3": {"bucket": {"name": BUCKET}, "object": {"key": key}}, "awsRegion": REGION}]
    })
    r = subprocess.run(
        ["aws", "lambda", "invoke", "--function-name", FUNCTION, "--region", REGION,
         "--payload", payload, "--cli-binary-format", "raw-in-base64-out", "/tmp/out.json"],
        capture_output=True, text=True
    )
    status = "OK" if r.returncode == 0 else f"FAIL: {r.stderr[:80]}"
    print(f"  {status}: {key.split('/')[-1]}")

print("Done")
