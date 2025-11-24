const { execSync } = require('child_process');

try {
  // Get the latest tag (which was just created by npm version)
  const tag = execSync('git describe --tags --abbrev=0').toString().trim();

  if (!tag) {
    console.error('Error: No git tag found.');
    process.exit(1);
  }

  const branchName = `release/${tag}`;
  console.log(`Creating release branch: ${branchName}`);

  // Create the branch
  execSync(`git branch ${branchName}`);

  // Push the branch
  console.log(`Pushing release branch: ${branchName}`);
  execSync(`git push origin ${branchName}`);

} catch (error) {
  console.error('Failed to create or push release branch:', error.message);
  process.exit(1);
}
