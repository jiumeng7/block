const ARBITER = "0x29054C682c64e8eE8207Bbe97660c15F7de336F7";

const deployEscrow: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();
  await hre.deployments.deploy("Escrow", {
    from: deployer,
    args: [ARBITER],
    log: true,
    autoMine: true,
  });
};
export default deployEscrow;
deployEscrow.tags = ["EscrowHZJ202430552449"];
