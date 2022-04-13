import { expect } from 'chai';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { ConvexToken, CvxLockerV2, PirexCvx } from '../typechain-types';

// Tests the emergency relock mechanism on CvxLockerV2 shutdown
describe('PirexCvx-Shutdown', function () {
  let notAdmin: SignerWithAddress;
  let pCvx: PirexCvx;
  let pCvxNew: PirexCvx;
  let cvx: ConvexToken;
  let cvxLocker: CvxLockerV2;
  let cvxLockerNew: CvxLockerV2;
  let zeroAddress: string;

  before(async function () {
    ({
      notAdmin,
      pCvx,
      pCvxNew,
      cvx,
      cvxLocker,
      cvxLockerNew,
      zeroAddress,
    } = this);
  });

  describe('emergency', function () {
    before(async function () {
      await pCvx.setPauseState(true);
    });

    it('Should revert if not called by owner', async function () {
      await expect(pCvx.connect(notAdmin).relock()).to.be.revertedWith(
        'Ownable: caller is not the owner'
      );

      await expect(pCvx.connect(notAdmin).unlock()).to.be.revertedWith(
        'Ownable: caller is not the owner'
      );

      await expect(
        pCvx.connect(notAdmin).setPirexCvxMigration(zeroAddress)
      ).to.be.revertedWith('Ownable: caller is not the owner');

      await expect(
        pCvx.connect(notAdmin).emergencyMigrateTokens([zeroAddress])
      ).to.be.revertedWith('Ownable: caller is not the owner');
    });

    it('Should revert if not paused', async function () {
      await pCvx.setPauseState(false);

      await expect(pCvx.relock()).to.be.revertedWith('Pausable: not paused');
      await expect(pCvx.unlock()).to.be.revertedWith('Pausable: not paused');
      await expect(pCvx.setPirexCvxMigration(zeroAddress)).to.be.revertedWith(
        'Pausable: not paused'
      );
      await expect(
        pCvx.emergencyMigrateTokens([zeroAddress])
      ).to.be.revertedWith('Pausable: not paused');
    });

    it('Should perform emergency measures after the shutdown in CvxLockerV2', async function () {
      await pCvx.setPauseState(true);

      // Simulate shutdown in the old/current locker
      await cvxLocker.shutdown();

      // Withdraw all forced-unlocked CVX
      await pCvx.unlock();

      const cvxBalance = await cvx.balanceOf(pCvx.address);

      // Set migration and migrate tokens over
      await pCvx.setPirexCvxMigration(pCvxNew.address);
      const pirexCvxMigration = await pCvx.pirexCvxMigration();
      expect(pirexCvxMigration).to.equal(pCvxNew.address);

      const pCvxNewBalanceBefore = await cvx.balanceOf(pCvxNew.address);
      await pCvx.emergencyMigrateTokens([cvx.address]);
      const pCvxNewBalanceAfter = await cvx.balanceOf(pCvxNew.address);
      expect(pCvxNewBalanceAfter).to.equal(
        pCvxNewBalanceBefore.add(cvxBalance)
      );

      // Attempt to relock with the new locker
      await pCvxNew.relock();

      // Confirm that the correct amount of Cvx are relocked
      const lockedBalanceAfter = await cvxLockerNew.lockedBalanceOf(
        pCvxNew.address
      );
      expect(lockedBalanceAfter).to.equal(cvxBalance);
    });
  });
});
